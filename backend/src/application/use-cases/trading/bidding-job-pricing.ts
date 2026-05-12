import {
    TRADING_BIDDING_JOB_PRICING_SOURCE_KIND,
    type TradingBiddingJobPricingSource,
} from "@artgod/shared/types";
import type { BiddingPriceTiersRepositoryPort } from "./bidding-price-tier-ports.js";
import { resolveBiddingPriceTierGraph } from "./bidding-price-tiers.js";
import {
    assertFloorNotAboveCeiling,
    parsePositiveEthToWei,
    TradingValidationError,
} from "./types.js";

// Captures HTTP/use-case pricing input before it is normalized to wei.
export type BiddingJobPricingInput = {
    floorEth?: string;
    ceilingEth?: string;
    deltaEth: string;
    priceTierId?: string | null;
};

// Carries normalized bot-facing prices plus the explanatory persisted metadata.
export type ResolvedBiddingJobPricing = {
    floorWei: string;
    ceilingWei: string;
    deltaWei: string;
    priceTierId: string | null;
    pricingSource: TradingBiddingJobPricingSource;
};

// Reads collection price tiers needed to resolve tier-backed job pricing.
export type BiddingJobPriceTierReadPort = Pick<
    BiddingPriceTiersRepositoryPort,
    "listCollectionPriceTiers"
>;

// Resolves manual or tier-backed human price input into the scalar bot-facing job contract.
export function resolveBiddingJobPricing(params: {
    chainId: number;
    collectionId: number;
    input: BiddingJobPricingInput;
    priceTierReadPort: BiddingJobPriceTierReadPort;
}): ResolvedBiddingJobPricing {
    const deltaWei = parsePositiveEthToWei(params.input.deltaEth, "deltaEth");
    const priceTierId = params.input.priceTierId?.trim() || null;
    if (!priceTierId) {
        return resolveManualBiddingJobPricing({
            floorEth: params.input.floorEth,
            ceilingEth: params.input.ceilingEth,
            deltaWei,
        });
    }

    // Load active collection tiers and resolve the current graph before using a tier snapshot.
    const tier = resolveBiddingPriceTierGraph(
        params.priceTierReadPort.listCollectionPriceTiers({
            chainId: params.chainId,
            collectionId: params.collectionId,
        }),
    ).find((candidate) => candidate.tierId === priceTierId);
    if (!tier) {
        throw new TradingValidationError("priceTierId was not found");
    }

    return {
        floorWei: tier.resolvedFloorWei,
        ceilingWei: tier.resolvedCeilingWei,
        deltaWei,
        priceTierId: tier.tierId,
        pricingSource: {
            kind: TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.PriceTier,
            tierId: tier.tierId,
            tierName: tier.name,
            resolvedAt: tier.resolvedAt,
            resolvedFloorWei: tier.resolvedFloorWei,
            resolvedCeilingWei: tier.resolvedCeilingWei,
            deltaWei,
        },
    };
}

function resolveManualBiddingJobPricing(params: {
    floorEth?: string;
    ceilingEth?: string;
    deltaWei: string;
}): ResolvedBiddingJobPricing {
    if (params.floorEth === undefined) {
        throw new TradingValidationError("floorEth is required");
    }
    if (params.ceilingEth === undefined) {
        throw new TradingValidationError("ceilingEth is required");
    }

    const floorWei = parsePositiveEthToWei(params.floorEth, "floorEth");
    const ceilingWei = parsePositiveEthToWei(params.ceilingEth, "ceilingEth");
    assertFloorNotAboveCeiling(floorWei, ceilingWei);

    return {
        floorWei,
        ceilingWei,
        deltaWei: params.deltaWei,
        priceTierId: null,
        pricingSource: {
            kind: TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.Manual,
        },
    };
}
