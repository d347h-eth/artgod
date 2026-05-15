import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import {
    TRADING_BOT_KIND,
    TRADING_JOB_STATUS,
    TRADING_JOB_TARGET_KIND,
    type ChainRecord,
    type CollectionListItem,
    type PersistedBiddingJobRecord,
    type TradingBiddingJobTargetDescriptor,
} from "@artgod/shared/types";
import {
    BiddingJobTargetLookupUseCase,
} from "./bidding-job-target-lookup.js";
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

describe("BiddingJobTargetLookupUseCase", () => {
    it("verifies token existence before resolving token job targets", () => {
        let tokenLookupCalled = false;
        let capturedTarget: TradingBiddingJobTargetDescriptor | null = null;
        const useCase = buildUseCase({
            getCollectionTokenDetail: ({ tokenId }) => {
                tokenLookupCalled = true;
                return { tokenId: tokenId.trim() };
            },
            findJobByTarget: ({ target }) => {
                capturedTarget = target;
                return tokenJob({ tokenId: "42" });
            },
        });

        const result = useCase.lookupBiddingJobTarget({
            chainRef: "ethereum",
            collectionRef: "terraforms",
            target: {
                type: "token",
                tokenId: " 42 ",
            },
        });

        assert.equal(tokenLookupCalled, true);
        assert.deepEqual(capturedTarget, {
            targetKind: TRADING_JOB_TARGET_KIND.Token,
            tokenId: "42",
        });
        assert.equal(result.job?.target.type, "token");
    });

    it("maps collection targets with default quantity", () => {
        let capturedTarget: TradingBiddingJobTargetDescriptor | null = null;
        const useCase = buildUseCase({
            findJobByTarget: ({ target }) => {
                capturedTarget = target;
                return null;
            },
        });

        const result = useCase.lookupBiddingJobTarget({
            chainRef: "ethereum",
            collectionRef: "terraforms",
            target: {
                type: "collection",
            },
        });

        assert.equal(result.job, null);
        assert.deepEqual(capturedTarget, {
            targetKind: TRADING_JOB_TARGET_KIND.Collection,
            quantity: 1,
            targetTraits: [],
        });
    });

    it("normalizes trait targets before repository lookup", () => {
        let capturedTarget: TradingBiddingJobTargetDescriptor | null = null;
        const useCase = buildUseCase({
            findJobByTarget: ({ target }) => {
                capturedTarget = target;
                return null;
            },
        });

        useCase.lookupBiddingJobTarget({
            chainRef: "ethereum",
            collectionRef: "terraforms",
            target: {
                type: "trait",
                quantity: 2,
                targetTraits: [
                    { type: "Mode", value: "Terrain" },
                    { type: "Biome", value: "42" },
                ],
            },
        });

        assert.deepEqual(capturedTarget, {
            targetKind: TRADING_JOB_TARGET_KIND.Collection,
            quantity: 2,
            targetTraits: [
                { type: "Biome", value: "42" },
                { type: "Mode", value: "Terrain" },
            ],
        });
    });

    it("rejects invalid target quantities and duplicate traits", () => {
        const useCase = buildUseCase({});

        assert.throws(
            () =>
                useCase.lookupBiddingJobTarget({
                    chainRef: "ethereum",
                    collectionRef: "terraforms",
                    target: {
                        type: "collection",
                        quantity: 0,
                    },
                }),
            /target.quantity must be an integer > 0/,
        );
        assert.throws(
            () =>
                useCase.lookupBiddingJobTarget({
                    chainRef: "ethereum",
                    collectionRef: "terraforms",
                    target: {
                        type: "trait",
                        targetTraits: [
                            { type: "Mode", value: "Terrain" },
                            { type: "Mode", value: "Terrain" },
                        ],
                    },
                }),
            /duplicate target trait Mode=Terrain/,
        );
        assert.throws(
            () =>
                useCase.lookupBiddingJobTarget({
                    chainRef: "ethereum",
                    collectionRef: "terraforms",
                    target: {
                        type: "trait",
                        targetTraits: [],
                    },
                }),
            TradingValidationError,
        );
    });
});

function buildUseCase(params: {
    getCollectionTokenDetail?: (params: {
        chainId: number;
        collectionId: number;
        tokenId: string;
    }) => { tokenId: string };
    findJobByTarget?: (params: {
        chainId: number;
        collectionId: number;
        target: TradingBiddingJobTargetDescriptor;
    }) => PersistedBiddingJobRecord | null;
}): BiddingJobTargetLookupUseCase {
    return new BiddingJobTargetLookupUseCase(
        1,
        {
            resolveChainRef: () => CHAIN,
        },
        {
            resolveCollectionRef: () => COLLECTION,
            getCollectionTokenDetail:
                params.getCollectionTokenDetail ?? (({ tokenId }) => ({ tokenId })),
        },
        {
            findJobByTarget: params.findJobByTarget ?? (() => null),
        },
    );
}

function tokenJob(
    overrides: Partial<Extract<PersistedBiddingJobRecord, { targetKind: "token" }>>,
): Extract<PersistedBiddingJobRecord, { targetKind: "token" }> {
    return {
        jobId: "job-token",
        botKind: TRADING_BOT_KIND.Bidding,
        chainId: 1,
        collectionId: COLLECTION.collectionId,
        collectionSlug: COLLECTION.slug,
        collectionOpenseaSlug: COLLECTION.slug,
        collectionAddress: COLLECTION.address,
        status: TRADING_JOB_STATUS.Enabled,
        targetKind: TRADING_JOB_TARGET_KIND.Token,
        tokenId: "1",
        quantity: null,
        targetTraits: [],
        competitorTraits: [],
        floorWei: "100000000000000000",
        ceilingWei: "200000000000000000",
        deltaWei: "1000000000000000",
        priceTierId: null,
        pricingSource: null,
        revision: 1,
        createdAt: "2026-05-15T00:00:00Z",
        updatedAt: "2026-05-15T00:00:00Z",
        archivedAt: null,
        runtime: null,
        ...overrides,
    };
}
