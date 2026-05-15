import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import {
    TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND,
    TRADING_BIDDING_PRICE_TIER_DELTA_KIND,
    TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND,
    TRADING_JOB_STATUS,
    TRADING_BIDDING_TIER_SELECTION_MODE,
} from "@artgod/shared/types";
import {
    COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
} from "../../../application/use-cases/trading/bidding-bid-book.js";
import {
    ArchiveCollectionBiddingPriceTierHttpAdapter,
} from "./archive-collection-bidding-price-tier.js";
import {
    ApplyBiddingPriceTierReapplyHttpAdapter,
} from "./apply-bidding-price-tier-reapply.js";
import { parsePriceTierBody } from "./bidding-price-tier-http.js";
import {
    LookupBiddingJobTargetHttpAdapter,
} from "./lookup-bidding-job-target.js";
import {
    UpdateCollectionBiddingSettingsHttpAdapter,
} from "./update-collection-bidding-settings.js";
import {
    UpsertBatchTokenBiddingJobsHttpAdapter,
} from "./upsert-batch-token-bidding-jobs.js";
import {
    UpsertTraitBiddingJobHttpAdapter,
} from "./upsert-trait-bidding-job.js";

describe("trading HTTP adapters", () => {
    it("parses price-tier DTOs across supported config kinds", () => {
        const parsed = parsePriceTierBody({
            tierId: "tier-1",
            name: "Base",
            status: TRADING_JOB_STATUS.Enabled,
            sortOrder: 2,
            parentTierId: "parent",
            floorConfig: {
                kind: TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.ParentDelta,
                deltaKind: TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Percent,
                percent: "10",
            },
            ceilingConfig: {
                kind: TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.FloorDelta,
                deltaKind: TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Absolute,
                deltaEth: "0.05",
            },
            deltaEth: "0.001",
        });

        assert.deepEqual(parsed, {
            tierId: "tier-1",
            name: "Base",
            status: TRADING_JOB_STATUS.Enabled,
            sortOrder: 2,
            parentTierId: "parent",
            floorConfig: {
                kind: TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.ParentDelta,
                deltaKind: TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Percent,
                percent: "10",
            },
            ceilingConfig: {
                kind: TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.FloorDelta,
                deltaKind: TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Absolute,
                deltaEth: "0.05",
            },
            deltaEth: "0.001",
        });
    });

    it("rejects malformed price-tier DTOs before use-case validation", () => {
        assert.throws(
            () =>
                parsePriceTierBody({
                    name: "Bad",
                    status: TRADING_JOB_STATUS.Enabled,
                    sortOrder: 1.5,
                    floorConfig: {
                        kind: TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.Fixed,
                        valueEth: "1",
                    },
                    ceilingConfig: {
                        kind: TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.Fixed,
                        valueEth: "1.2",
                    },
                    deltaEth: "0.001",
                }),
            /sortOrder must be an integer/,
        );
        assert.throws(
            () =>
                parsePriceTierBody({
                    name: "Bad",
                    status: TRADING_JOB_STATUS.Enabled,
                    sortOrder: 1,
                    floorConfig: {
                        kind: TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.ParentDelta,
                        deltaKind: "bad",
                    },
                    ceilingConfig: {
                        kind: TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.Fixed,
                        valueEth: "1.2",
                    },
                    deltaEth: "0.001",
                }),
            /floorConfig\.deltaKind is invalid/,
        );
    });

    it("maps batch token job token-id and filter selections", async () => {
        const captured: unknown[] = [];
        const adapter = new UpsertBatchTokenBiddingJobsHttpAdapter({
            upsertBatchTokenBiddingJobs: (input) => {
                captured.push(input);
                return input as never;
            },
        });

        await adapter.handle(
            request({
                params: { chain_ref: "ethereum", collection_ref: "terraforms" },
                body: {
                    status: TRADING_JOB_STATUS.Enabled,
                    deltaEth: "0.001",
                    selection: {
                        type: "token_ids",
                        tokenIds: ["1", " 2 "],
                    },
                },
            }),
        );
        await adapter.handle(
            request({
                params: { chain_ref: "ethereum", collection_ref: "terraforms" },
                body: {
                    status: TRADING_JOB_STATUS.Paused,
                    floorEth: "0.1",
                    ceilingEth: "0.2",
                    deltaEth: "0.001",
                    priceTierId: null,
                    selection: {
                        type: "filter",
                        tokenStatus: "listed_then_unlisted",
                        traits: [{ key: "Mode", value: "Terrain" }],
                        traitRanges: [
                            { key: "Level", fromValue: "1", toValue: "10" },
                        ],
                    },
                },
            }),
        );

        assert.deepEqual(captured, [
            {
                chainRef: "ethereum",
                collectionRef: "terraforms",
                status: TRADING_JOB_STATUS.Enabled,
                floorEth: undefined,
                ceilingEth: undefined,
                deltaEth: "0.001",
                priceTierId: undefined,
                selection: {
                    type: "token_ids",
                    tokenIds: ["1", " 2 "],
                },
            },
            {
                chainRef: "ethereum",
                collectionRef: "terraforms",
                status: TRADING_JOB_STATUS.Paused,
                floorEth: "0.1",
                ceilingEth: "0.2",
                deltaEth: "0.001",
                priceTierId: undefined,
                selection: {
                    type: "filter",
                    tokenStatus: "listed_then_unlisted",
                    traits: [{ key: "Mode", value: "Terrain" }],
                    traitRanges: [
                        { key: "Level", fromValue: "1", toValue: "10" },
                    ],
                },
            },
        ]);
    });

    it("maps token-offer batch selections and rejects invalid join modes", async () => {
        let captured: unknown;
        const adapter = new UpsertBatchTokenBiddingJobsHttpAdapter({
            upsertBatchTokenBiddingJobs: (input) => {
                captured = input;
                return input as never;
            },
        });

        await adapter.handle(
            request({
                params: { chain_ref: "ethereum", collection_ref: "terraforms" },
                body: {
                    status: TRADING_JOB_STATUS.Enabled,
                    deltaEth: "0.001",
                    selection: {
                        type: "token_offer_filter",
                        traits: [{ key: "Mode", value: "Terrain" }],
                        traitRanges: [],
                        traitJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
                        makerAddress: "0x1111111111111111111111111111111111111111",
                    },
                },
            }),
        );

        assert.deepEqual((captured as { selection: unknown }).selection, {
            type: "token_offer_filter",
            traits: [{ key: "Mode", value: "Terrain" }],
            traitRanges: [],
            traitJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
            makerAddress: "0x1111111111111111111111111111111111111111",
        });
        await assert.rejects(
            () =>
                adapter.handle(
                    request({
                        params: {
                            chain_ref: "ethereum",
                            collection_ref: "terraforms",
                        },
                        body: {
                            status: TRADING_JOB_STATUS.Enabled,
                            deltaEth: "0.001",
                            selection: {
                                type: "token_offer_filter",
                                traitJoinMode: "xor",
                            },
                        },
                    }),
                ),
            ReadModelBadRequestError,
        );
        await assert.rejects(
            () =>
                adapter.handle(
                    request({
                        params: {
                            chain_ref: "ethereum",
                            collection_ref: "terraforms",
                        },
                        body: {
                            status: TRADING_JOB_STATUS.Enabled,
                            deltaEth: "0.001",
                            selection: {
                                type: "token_offer_filter",
                                traitJoinMode:
                                    COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And,
                                makerAddress: 123,
                            },
                        },
                    }),
                ),
            /selection\.makerAddress must be a string/,
        );
    });

    it("rejects malformed batch token selection filters", async () => {
        const adapter = new UpsertBatchTokenBiddingJobsHttpAdapter({
            upsertBatchTokenBiddingJobs: (input) => input as never,
        });

        await assert.rejects(
            () =>
                adapter.handle(
                    request({
                        params: {
                            chain_ref: "ethereum",
                            collection_ref: "terraforms",
                        },
                        body: {
                            status: TRADING_JOB_STATUS.Enabled,
                            deltaEth: "0.001",
                            selection: {
                                type: "filter",
                                tokenStatus: "owned",
                            },
                        },
                    }),
                ),
            /selection\.tokenStatus is invalid/,
        );
        await assert.rejects(
            () =>
                adapter.handle(
                    request({
                        params: {
                            chain_ref: "ethereum",
                            collection_ref: "terraforms",
                        },
                        body: {
                            status: TRADING_JOB_STATUS.Enabled,
                            deltaEth: "0.001",
                            selection: {
                                type: "filter",
                                tokenStatus: "all",
                                traits: [null],
                            },
                        },
                    }),
                ),
            /selection\.traits entries must be objects/,
        );
        await assert.rejects(
            () =>
                adapter.handle(
                    request({
                        params: {
                            chain_ref: "ethereum",
                            collection_ref: "terraforms",
                        },
                        body: {
                            status: TRADING_JOB_STATUS.Enabled,
                            deltaEth: "0.001",
                            selection: {
                                type: "filter",
                                tokenStatus: "all",
                                traitRanges: [null],
                            },
                        },
                    }),
                ),
            /selection\.traitRanges entries must be objects/,
        );
        await assert.rejects(
            () =>
                adapter.handle(
                    request({
                        params: {
                            chain_ref: "ethereum",
                            collection_ref: "terraforms",
                        },
                        body: {
                            status: TRADING_JOB_STATUS.Enabled,
                            deltaEth: "0.001",
                            selection: {
                                type: "token_ids",
                                tokenIds: "1",
                            },
                        },
                    }),
                ),
            /selection\.tokenIds must be an array/,
        );
    });

    it("maps target lookup DTOs and rejects invalid targets", async () => {
        let captured: unknown;
        const adapter = new LookupBiddingJobTargetHttpAdapter({
            lookupBiddingJobTarget: (input) => {
                captured = input;
                return input as never;
            },
        });

        await adapter.handle(
            request({
                params: { chain_ref: "ethereum", collection_ref: "terraforms" },
                body: {
                    target: {
                        type: "trait",
                        quantity: 2,
                        targetTraits: [{ type: "Mode", value: "Terrain" }],
                    },
                },
            }),
        );

        assert.deepEqual(captured, {
            chainRef: "ethereum",
            collectionRef: "terraforms",
            target: {
                type: "trait",
                quantity: 2,
                targetTraits: [{ type: "Mode", value: "Terrain" }],
            },
        });
        await assert.rejects(
            () =>
                adapter.handle(
                    request({
                        params: {
                            chain_ref: "ethereum",
                            collection_ref: "terraforms",
                        },
                        body: { target: { type: "collection", quantity: -1 } },
                    }),
                ),
            /target\.quantity must be an integer > 0/,
        );
        await assert.rejects(
            () =>
                adapter.handle(
                    request({
                        params: {
                            chain_ref: "ethereum",
                            collection_ref: "terraforms",
                        },
                        body: {
                            target: {
                                type: "trait",
                                targetTraits: [],
                            },
                        },
                    }),
                ),
            /target\.targetTraits is required/,
        );
        await assert.rejects(
            () =>
                adapter.handle(
                    request({
                        params: {
                            chain_ref: "ethereum",
                            collection_ref: "terraforms",
                        },
                        body: {
                            target: {
                                type: "trait",
                                targetTraits: [null],
                            },
                        },
                    }),
                ),
            /target\.targetTraits entries must be objects/,
        );
    });

    it("maps trait job DTOs and rejects malformed trait targets", async () => {
        let captured: unknown;
        const adapter = new UpsertTraitBiddingJobHttpAdapter({
            upsertTraitBiddingJob: (input) => {
                captured = input;
                return input as never;
            },
        });

        await adapter.handle(
            request({
                params: { chain_ref: "ethereum", collection_ref: "terraforms" },
                body: {
                    status: TRADING_JOB_STATUS.Enabled,
                    floorEth: "0.1",
                    ceilingEth: "0.2",
                    deltaEth: "0.001",
                    quantity: 2,
                    targetTraits: [{ type: "Mode", value: "Terrain" }],
                },
            }),
        );

        assert.deepEqual(captured, {
            chainRef: "ethereum",
            collectionRef: "terraforms",
            status: TRADING_JOB_STATUS.Enabled,
            floorEth: "0.1",
            ceilingEth: "0.2",
            deltaEth: "0.001",
            priceTierId: undefined,
            quantity: 2,
            targetTraits: [{ type: "Mode", value: "Terrain" }],
        });
        await assert.rejects(
            () =>
                adapter.handle(
                    request({
                        params: {
                            chain_ref: "ethereum",
                            collection_ref: "terraforms",
                        },
                        body: {
                            status: TRADING_JOB_STATUS.Enabled,
                            deltaEth: "0.001",
                            quantity: 0,
                            targetTraits: [{ type: "Mode", value: "Terrain" }],
                        },
                    }),
                ),
            /quantity must be an integer > 0/,
        );
        await assert.rejects(
            () =>
                adapter.handle(
                    request({
                        params: {
                            chain_ref: "ethereum",
                            collection_ref: "terraforms",
                        },
                        body: {
                            status: TRADING_JOB_STATUS.Enabled,
                            deltaEth: "0.001",
                            targetTraits: [],
                        },
                    }),
                ),
            /targetTraits is required/,
        );
        await assert.rejects(
            () =>
                adapter.handle(
                    request({
                        params: {
                            chain_ref: "ethereum",
                            collection_ref: "terraforms",
                        },
                        body: {
                            status: TRADING_JOB_STATUS.Enabled,
                            deltaEth: "0.001",
                            targetTraits: [null],
                        },
                    }),
                ),
            /targetTraits entries must be objects/,
        );
    });

    it("maps archive and settings DTOs without leaking transport fields", async () => {
        let archiveInput: unknown;
        const archiveAdapter = new ArchiveCollectionBiddingPriceTierHttpAdapter({
            archiveCollectionBiddingPriceTier: (input) => {
                archiveInput = input;
                return input as never;
            },
        });
        let settingsInput: unknown;
        const settingsAdapter = new UpdateCollectionBiddingSettingsHttpAdapter({
            updateCollectionBiddingSettings: (input) => {
                settingsInput = input;
                return input as never;
            },
        });

        await archiveAdapter.handle(
            request({
                params: {
                    chain_ref: "ethereum",
                    collection_ref: "terraforms",
                    tier_id: "tier-1",
                },
            }),
        );
        await settingsAdapter.handle(
            request({
                params: { chain_ref: "ethereum", collection_ref: "terraforms" },
                body: {
                    tierSelectionMode: TRADING_BIDDING_TIER_SELECTION_MODE.Dropdown,
                    defaultDeltaEth: "0.002",
                },
            }),
        );

        assert.deepEqual(archiveInput, {
            chainRef: "ethereum",
            collectionRef: "terraforms",
            tierId: "tier-1",
        });
        assert.deepEqual(settingsInput, {
            chainRef: "ethereum",
            collectionRef: "terraforms",
            tierSelectionMode: TRADING_BIDDING_TIER_SELECTION_MODE.Dropdown,
            defaultDeltaEth: "0.002",
        });
        await assert.rejects(
            () =>
                settingsAdapter.handle(
                    request({
                        params: {
                            chain_ref: "ethereum",
                            collection_ref: "terraforms",
                        },
                        body: {
                            tierSelectionMode:
                                TRADING_BIDDING_TIER_SELECTION_MODE.Buttons,
                            defaultDeltaEth: 1,
                        },
                    }),
                ),
            /defaultDeltaEth must be a string/,
        );
    });

    it("maps tier reapply job ids and rejects malformed arrays", async () => {
        let captured: unknown;
        const adapter = new ApplyBiddingPriceTierReapplyHttpAdapter({
            applyBiddingPriceTierReapply: (input) => {
                captured = input;
                return input as never;
            },
        });

        await adapter.handle(
            request({
                params: {
                    chain_ref: "ethereum",
                    collection_ref: "terraforms",
                    tier_id: "tier-1",
                },
                body: {
                    jobIds: [" job-a ", "job-b"],
                },
            }),
        );

        assert.deepEqual(captured, {
            chainRef: "ethereum",
            collectionRef: "terraforms",
            tierId: "tier-1",
            jobIds: ["job-a", "job-b"],
        });
        await assert.rejects(
            () =>
                adapter.handle(
                    request({
                        params: {
                            chain_ref: "ethereum",
                            collection_ref: "terraforms",
                            tier_id: "tier-1",
                        },
                        body: { jobIds: ["job-a", ""] },
                    }),
                ),
            /jobIds\[1\] must be a string/,
        );
    });
});

function request<T extends object>(value: T): T {
    return value;
}
