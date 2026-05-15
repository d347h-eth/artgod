import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import {
    TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND,
    TRADING_BIDDING_PRICE_TIER_DELTA_KIND,
    TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND,
    TRADING_JOB_STATUS,
    type ChainRecord,
    type CollectionListItem,
    type PersistedBiddingPriceTierRecord,
} from "@artgod/shared/types";
import type {
    BiddingPriceTierResolutionUpdate,
    UpsertBiddingPriceTierRecordInput,
} from "./bidding-price-tier-ports.js";
import {
    UpsertCollectionBiddingPriceTierUseCase,
    type UpsertCollectionBiddingPriceTierInput,
} from "./upsert-collection-bidding-price-tier.js";

const CHAIN: ChainRecord = {
    id: 1,
    type: "evm",
    publicChainId: 1,
    slug: "ethereum",
    name: "Ethereum",
};

const COLLECTION: CollectionListItem = {
    chainId: 1,
    collectionId: 7,
    slug: "terraforms",
    address: "0x1111111111111111111111111111111111111111",
    standard: "erc721",
    status: "live",
    deploymentBlock: 1,
    bootstrapAnchorBlock: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
};

describe("UpsertCollectionBiddingPriceTierUseCase", () => {
    it("persists a trimmed tier and refreshes resolved scalar cache", () => {
        const upsertedInputs: UpsertBiddingPriceTierRecordInput[] = [];
        const resolutionUpdates: BiddingPriceTierResolutionUpdate[] = [];
        const useCase = buildUseCase({
            tiers: [],
            upsertPriceTier: (input) => {
                upsertedInputs.push(input);
                return priceTier({
                    tierId: "saved-tier",
                    name: input.name,
                    status: input.status,
                    sortOrder: input.sortOrder,
                    parentTierId: input.parentTierId,
                    floorConfig: input.floorConfig,
                    ceilingConfig: input.ceilingConfig,
                    deltaWei: input.deltaWei,
                    resolvedFloorWei: input.resolvedFloorWei,
                    resolvedCeilingWei: input.resolvedCeilingWei,
                    resolvedAt: input.resolvedAt,
                    lastError: input.lastError,
                });
            },
            updatePriceTierResolutions: (updates) => {
                resolutionUpdates.push(...updates);
            },
        });

        const result = useCase.upsertCollectionBiddingPriceTier(
            input({ name: "  Base  " }),
        );

        assert.equal(result.tier.tierId, "saved-tier");
        assert.equal(result.tier.name, "Base");
        assert.equal(result.tier.resolvedFloorEth, "0.1");
        assert.equal(result.tier.resolvedCeilingEth, "0.2");
        assert.equal(upsertedInputs[0]?.name, "Base");
        assert.deepEqual(
            resolutionUpdates.map((update) => update.tierId),
            ["saved-tier"],
        );
    });

    it("rejects blank names and invalid sort order before persistence", () => {
        let upsertCalls = 0;
        const useCase = buildUseCase({
            tiers: [],
            upsertPriceTier: () => {
                upsertCalls += 1;
                throw new Error("Unexpected price tier persistence");
            },
        });

        assert.throws(
            () => useCase.upsertCollectionBiddingPriceTier(input({ name: " " })),
            /name is required/,
        );
        assert.throws(
            () =>
                useCase.upsertCollectionBiddingPriceTier(
                    input({ sortOrder: 1.5 }),
                ),
            /sortOrder must be an integer/,
        );
        assert.equal(upsertCalls, 0);
    });

    it("rejects missing parents before writing the candidate tier", () => {
        let upsertCalls = 0;
        const useCase = buildUseCase({
            tiers: [],
            upsertPriceTier: () => {
                upsertCalls += 1;
                throw new Error("Unexpected price tier persistence");
            },
        });

        assert.throws(
            () =>
                useCase.upsertCollectionBiddingPriceTier(
                    input({
                        parentTierId: "missing",
                        floorConfig: {
                            kind: TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.ParentDelta,
                            deltaKind: TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Absolute,
                            deltaEth: "0.1",
                        },
                    }),
                ),
            /references missing parent missing/,
        );
        assert.equal(upsertCalls, 0);
    });

    it("rejects invalid candidate graphs before persistence", () => {
        let upsertCalls = 0;
        const useCase = buildUseCase({
            tiers: [],
            upsertPriceTier: () => {
                upsertCalls += 1;
                throw new Error("Unexpected price tier persistence");
            },
        });

        assert.throws(
            () =>
                useCase.upsertCollectionBiddingPriceTier(
                    input({
                        floorConfig: {
                            kind: TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.Fixed,
                            valueEth: "0.3",
                        },
                        ceilingConfig: {
                            kind: TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.Fixed,
                            valueEth: "0.2",
                        },
                    }),
                ),
            /floor must be <= ceiling/,
        );
        assert.equal(upsertCalls, 0);
    });
});

function buildUseCase(params: {
    tiers: PersistedBiddingPriceTierRecord[];
    upsertPriceTier?: (
        input: UpsertBiddingPriceTierRecordInput,
    ) => PersistedBiddingPriceTierRecord;
    updatePriceTierResolutions?: (
        updates: BiddingPriceTierResolutionUpdate[],
    ) => void;
}): UpsertCollectionBiddingPriceTierUseCase {
    return new UpsertCollectionBiddingPriceTierUseCase(
        1,
        {
            resolveChainRef: () => CHAIN,
        },
        {
            resolveCollectionRef: () => COLLECTION,
        },
        {
            listCollectionPriceTiers: () => params.tiers,
            upsertPriceTier:
                params.upsertPriceTier ??
                ((upsertInput) =>
                    priceTier({
                        tierId: upsertInput.tierId ?? "saved-tier",
                        name: upsertInput.name,
                        status: upsertInput.status,
                        sortOrder: upsertInput.sortOrder,
                        parentTierId: upsertInput.parentTierId,
                        floorConfig: upsertInput.floorConfig,
                        ceilingConfig: upsertInput.ceilingConfig,
                        deltaWei: upsertInput.deltaWei,
                        resolvedFloorWei: upsertInput.resolvedFloorWei,
                        resolvedCeilingWei: upsertInput.resolvedCeilingWei,
                        resolvedAt: upsertInput.resolvedAt,
                        lastError: upsertInput.lastError,
                    })),
            updatePriceTierResolutions:
                params.updatePriceTierResolutions ?? (() => {}),
        },
    );
}

function input(
    overrides: Partial<UpsertCollectionBiddingPriceTierInput> = {},
): UpsertCollectionBiddingPriceTierInput {
    return {
        chainRef: "ethereum",
        collectionRef: "terraforms",
        name: "Base",
        status: TRADING_JOB_STATUS.Enabled,
        sortOrder: 1,
        parentTierId: null,
        floorConfig: {
            kind: TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.Fixed,
            valueEth: "0.1",
        },
        ceilingConfig: {
            kind: TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.Fixed,
            valueEth: "0.2",
        },
        deltaEth: "0.001",
        ...overrides,
    };
}

function priceTier(
    overrides: Partial<PersistedBiddingPriceTierRecord>,
): PersistedBiddingPriceTierRecord {
    return {
        tierId: "tier",
        chainId: 1,
        collectionId: COLLECTION.collectionId,
        name: "Tier",
        status: TRADING_JOB_STATUS.Enabled,
        sortOrder: 1,
        parentTierId: null,
        floorConfig: {
            kind: TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.Fixed,
            valueEth: "0.1",
        },
        ceilingConfig: {
            kind: TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.Fixed,
            valueEth: "0.2",
        },
        deltaWei: "1000000000000000",
        resolvedFloorWei: "100000000000000000",
        resolvedCeilingWei: "200000000000000000",
        resolvedAt: "2026-05-15T00:00:00Z",
        lastError: null,
        revision: 1,
        createdAt: "2026-05-15T00:00:00Z",
        updatedAt: "2026-05-15T00:00:00Z",
        archivedAt: null,
        ...overrides,
    };
}
