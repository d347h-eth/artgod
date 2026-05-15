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
import {
    ArchiveCollectionBiddingPriceTierUseCase,
} from "./archive-collection-bidding-price-tier.js";
import { TradingValidationError } from "./types.js";

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

describe("ArchiveCollectionBiddingPriceTierUseCase", () => {
    it("archives a leaf tier and refreshes remaining active tier resolutions", () => {
        const parent = priceTier({
            tierId: "root",
            name: "Root",
            sortOrder: 1,
        });
        const child = priceTier({
            tierId: "child",
            name: "Child",
            sortOrder: 2,
            parentTierId: "root",
            floorConfig: {
                kind: TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.ParentDelta,
                deltaKind: TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Absolute,
                deltaEth: "0.1",
            },
            ceilingConfig: {
                kind: TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.ParentDelta,
                deltaKind: TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Absolute,
                deltaEth: "0.2",
            },
            resolvedFloorWei: "1100000000000000000",
            resolvedCeilingWei: "1400000000000000000",
        });
        const archivedChild = {
            ...child,
            status: TRADING_JOB_STATUS.Archived,
            archivedAt: "2026-05-15T00:00:00Z",
            revision: 2,
        };
        const resolutionUpdates: unknown[] = [];
        const useCase = buildUseCase({
            tiers: [parent, child],
            archivedById: new Map([["child", archivedChild]]),
            updatePriceTierResolutions: (updates) => {
                resolutionUpdates.push(...updates);
            },
        });

        const result = useCase.archiveCollectionBiddingPriceTier({
            chainRef: "ethereum",
            collectionRef: "terraforms",
            tierId: "child",
        });

        assert.equal(result.tier.tierId, "child");
        assert.equal(result.tier.status, TRADING_JOB_STATUS.Archived);
        assert.equal(result.tier.resolvedFloorEth, null);
        assert.deepEqual(
            result.tiers.map((tier) => tier.tierId),
            ["root"],
        );
        assert.equal(resolutionUpdates.length, 1);
        assert.deepEqual(resolutionUpdates, [
            {
                tierId: "root",
                resolvedFloorWei: "1000000000000000000",
                resolvedCeilingWei: "1200000000000000000",
                resolvedAt: (resolutionUpdates[0] as { resolvedAt: string })
                    .resolvedAt,
                lastError: null,
            },
        ]);
        assert.match(
            (resolutionUpdates[0] as { resolvedAt: string }).resolvedAt,
            /^\d{4}-\d{2}-\d{2}T/,
        );
    });

    it("rejects archiving a tier that still has an active child", () => {
        const parent = priceTier({ tierId: "root", name: "Root" });
        const child = priceTier({
            tierId: "child",
            name: "Child",
            parentTierId: "root",
        });
        let archiveCalled = false;
        const useCase = buildUseCase({
            tiers: [parent, child],
            archivePriceTier: () => {
                archiveCalled = true;
                return null;
            },
        });

        assert.throws(
            () =>
                useCase.archiveCollectionBiddingPriceTier({
                    chainRef: "ethereum",
                    collectionRef: "terraforms",
                    tierId: "root",
                }),
            /still has an active child/,
        );
        assert.equal(archiveCalled, false);
    });

    it("rejects missing or cross-collection tiers before archiving", () => {
        const useCase = buildUseCase({
            tiers: [],
            tierById: new Map([
                [
                    "foreign",
                    priceTier({
                        tierId: "foreign",
                        name: "Foreign",
                        collectionId: 999,
                    }),
                ],
            ]),
        });

        assert.throws(
            () =>
                useCase.archiveCollectionBiddingPriceTier({
                    chainRef: "ethereum",
                    collectionRef: "terraforms",
                    tierId: "missing",
                }),
            TradingValidationError,
        );
        assert.throws(
            () =>
                useCase.archiveCollectionBiddingPriceTier({
                    chainRef: "ethereum",
                    collectionRef: "terraforms",
                    tierId: "foreign",
                }),
            /price tier was not found/,
        );
    });

    it("rejects archive races where the repository no longer returns the tier", () => {
        const tier = priceTier({ tierId: "root", name: "Root" });
        const useCase = buildUseCase({
            tiers: [tier],
            archivedById: new Map([["root", null]]),
        });

        assert.throws(
            () =>
                useCase.archiveCollectionBiddingPriceTier({
                    chainRef: "ethereum",
                    collectionRef: "terraforms",
                    tierId: "root",
                }),
            /price tier was not found/,
        );
    });
});

function buildUseCase(params: {
    tiers: PersistedBiddingPriceTierRecord[];
    tierById?: Map<string, PersistedBiddingPriceTierRecord>;
    archivedById?: Map<string, PersistedBiddingPriceTierRecord | null>;
    archivePriceTier?: (
        tierId: string,
    ) => PersistedBiddingPriceTierRecord | null;
    updatePriceTierResolutions?: (updates: unknown[]) => void;
}): ArchiveCollectionBiddingPriceTierUseCase {
    const tierById =
        params.tierById ??
        new Map(params.tiers.map((tier) => [tier.tierId, tier]));
    return new ArchiveCollectionBiddingPriceTierUseCase(
        1,
        {
            resolveChainRef: () => CHAIN,
        },
        {
            resolveCollectionRef: () => COLLECTION,
        },
        {
            listCollectionPriceTiers: () => params.tiers,
            getPriceTierById: (tierId) => tierById.get(tierId) ?? null,
            archivePriceTier:
                params.archivePriceTier ??
                ((tierId) => params.archivedById?.get(tierId) ?? null),
            updatePriceTierResolutions:
                params.updatePriceTierResolutions ?? (() => {}),
        },
    );
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
            valueEth: "1",
        },
        ceilingConfig: {
            kind: TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.Fixed,
            valueEth: "1.2",
        },
        deltaWei: "1000000000000000",
        resolvedFloorWei: "1000000000000000000",
        resolvedCeilingWei: "1200000000000000000",
        resolvedAt: "2026-05-15T00:00:00Z",
        lastError: null,
        revision: 1,
        createdAt: "2026-05-15T00:00:00Z",
        updatedAt: "2026-05-15T00:00:00Z",
        archivedAt: null,
        ...overrides,
    };
}
