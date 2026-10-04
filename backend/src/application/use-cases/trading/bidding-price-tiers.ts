import { formatEther } from "viem";
import {
    resolveBiddingPriceTierCeilingWei,
    resolveBiddingPriceTierFloorWei,
} from "@artgod/shared/trading/bidding-price-tier-pricing";
import {
    TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND,
    TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND,
    TRADING_JOB_STATUS,
    type PersistedBiddingPriceTierRecord,
    type TradingBiddingPriceTierCeilingConfig,
    type TradingBiddingPriceTierFloorConfig,
    type TradingBiddingPriceTierStatus,
} from "@artgod/shared/types";
import { TradingValidationError } from "./types.js";

export type BiddingPriceTierView = {
    tierId: string;
    name: string;
    status: TradingBiddingPriceTierStatus;
    sortOrder: number;
    parentTierId: string | null;
    floorConfig: TradingBiddingPriceTierFloorConfig;
    ceilingConfig: TradingBiddingPriceTierCeilingConfig;
    deltaEth: string;
    resolvedFloorEth: string | null;
    resolvedCeilingEth: string | null;
    resolvedAt: string | null;
    lastError: string | null;
    revision: number;
    createdAt: string;
    updatedAt: string;
    archivedAt: string | null;
};

export type ResolvedBiddingPriceTier = PersistedBiddingPriceTierRecord & {
    resolvedFloorWei: string;
    resolvedCeilingWei: string;
    resolvedAt: string;
    lastError: string | null;
};

type TierResolutionState = {
    tier: PersistedBiddingPriceTierRecord;
    resolvedFloorWei: bigint;
    resolvedCeilingWei: bigint;
};

// Resolves active collection bidding tiers into scalar wei prices for UI and persistence.
export function resolveBiddingPriceTierGraph(
    tiers: PersistedBiddingPriceTierRecord[],
    resolvedAt: string = new Date().toISOString(),
): ResolvedBiddingPriceTier[] {
    const activeTiers = tiers.filter(
        (tier) => tier.status !== TRADING_JOB_STATUS.Archived,
    );
    const tiersById = new Map(activeTiers.map((tier) => [tier.tierId, tier]));
    const resolvedById = new Map<string, TierResolutionState>();
    const visiting = new Set<string>();

    for (const tier of activeTiers) {
        resolveTier(tier, tiersById, resolvedById, visiting);
    }

    return activeTiers
        .map((tier) => {
            const resolved = resolvedById.get(tier.tierId);
            if (!resolved) {
                throw new TradingValidationError(
                    `price tier ${tier.tierId} was not resolved`,
                );
            }
            return {
                ...tier,
                resolvedFloorWei: resolved.resolvedFloorWei.toString(),
                resolvedCeilingWei: resolved.resolvedCeilingWei.toString(),
                resolvedAt,
                lastError: null,
            };
        })
        .sort(comparePriceTierRecords);
}

export function mapPersistedBiddingPriceTierToView(
    tier: PersistedBiddingPriceTierRecord,
): BiddingPriceTierView {
    return {
        tierId: tier.tierId,
        name: tier.name,
        status: tier.status,
        sortOrder: tier.sortOrder,
        parentTierId: tier.parentTierId,
        floorConfig: tier.floorConfig,
        ceilingConfig: tier.ceilingConfig,
        deltaEth: formatWeiAsEth(tier.deltaWei),
        resolvedFloorEth: formatOptionalWeiAsEth(tier.resolvedFloorWei),
        resolvedCeilingEth: formatOptionalWeiAsEth(tier.resolvedCeilingWei),
        resolvedAt: tier.resolvedAt,
        lastError: tier.lastError,
        revision: tier.revision,
        createdAt: tier.createdAt,
        updatedAt: tier.updatedAt,
        archivedAt: tier.archivedAt,
    };
}

export function mapResolvedBiddingPriceTierToView(
    tier: ResolvedBiddingPriceTier,
): BiddingPriceTierView {
    return mapPersistedBiddingPriceTierToView(tier);
}

export function comparePriceTierRecords(
    left: PersistedBiddingPriceTierRecord,
    right: PersistedBiddingPriceTierRecord,
): number {
    if (left.sortOrder !== right.sortOrder) {
        return left.sortOrder - right.sortOrder;
    }
    const nameCompare = left.name.localeCompare(right.name);
    return nameCompare === 0
        ? left.tierId.localeCompare(right.tierId)
        : nameCompare;
}

function resolveTier(
    tier: PersistedBiddingPriceTierRecord,
    tiersById: Map<string, PersistedBiddingPriceTierRecord>,
    resolvedById: Map<string, TierResolutionState>,
    visiting: Set<string>,
): TierResolutionState {
    const existing = resolvedById.get(tier.tierId);
    if (existing) {
        return existing;
    }
    if (visiting.has(tier.tierId)) {
        throw new TradingValidationError(
            `price tier cycle detected at ${tier.tierId}`,
        );
    }

    visiting.add(tier.tierId);
    const parent = tier.parentTierId ? tiersById.get(tier.parentTierId) : null;
    if (tier.parentTierId && !parent) {
        throw new TradingValidationError(
            `price tier ${tier.tierId} references missing parent ${tier.parentTierId}`,
        );
    }
    const parentResolution = parent
        ? resolveTier(parent, tiersById, resolvedById, visiting)
        : null;

    const resolvedFloorWei = resolveFloorWei(tier, parentResolution);
    const resolvedCeilingWei = resolveCeilingWei(
        tier,
        resolvedFloorWei,
        parentResolution,
    );
    if (resolvedFloorWei > resolvedCeilingWei) {
        throw new TradingValidationError(
            `price tier ${tier.name} floor must be <= ceiling`,
        );
    }

    const state = {
        tier,
        resolvedFloorWei,
        resolvedCeilingWei,
    };
    resolvedById.set(tier.tierId, state);
    visiting.delete(tier.tierId);
    return state;
}

function resolveFloorWei(
    tier: PersistedBiddingPriceTierRecord,
    parent: TierResolutionState | null,
): bigint {
    const config = tier.floorConfig;
    if (
        config.kind !== TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.Fixed &&
        !parent
    ) {
        throw new TradingValidationError(
            `price tier ${tier.name} floor requires a parent tier`,
        );
    }
    return translatePricingError(() =>
        resolveBiddingPriceTierFloorWei(config, parent?.resolvedFloorWei),
    );
}

function resolveCeilingWei(
    tier: PersistedBiddingPriceTierRecord,
    floorWei: bigint,
    parent: TierResolutionState | null,
): bigint {
    const config = tier.ceilingConfig;
    if (
        config.kind ===
            TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.ParentDelta &&
        !parent
    ) {
        throw new TradingValidationError(
            `price tier ${tier.name} ceiling requires a parent tier`,
        );
    }
    return translatePricingError(() =>
        resolveBiddingPriceTierCeilingWei(
            config,
            floorWei,
            parent?.resolvedCeilingWei,
        ),
    );
}

function translatePricingError(resolve: () => bigint): bigint {
    try {
        return resolve();
    } catch (error) {
        if (error instanceof RangeError) {
            throw new TradingValidationError(error.message);
        }
        throw error;
    }
}

function formatOptionalWeiAsEth(value: string | null): string | null {
    return value === null ? null : formatEther(BigInt(value));
}

function formatWeiAsEth(value: string): string {
    return formatEther(BigInt(value));
}
