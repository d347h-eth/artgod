import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { Scope, Type, MarketEvent } from "../domain/market/event.js";
import {
    BIDDER_TARGET_TYPE,
    type BidderJob,
} from "../domain/market/strategy/job.js";
import {
    collectSnapshotBackedCollectionSlugs,
    collectTokenWarmCandidateCount,
    collectWatchedCollectionSlugs,
    createCriteriaOfferRefreshReasonResolver,
    createFailedCancellationReconcilerConfig,
    disposeBiddingRuntimeBidStream,
    formatOpenSeaStreamSocketError,
    shutdownBiddingRuntime,
} from "./bidding-runtime.js";
import { BIDDING_RUNTIME_METRIC_STATE } from "../adapters/observability/bidding-runtime-metric-contract.js";

function makeJob(
    id: string,
    collectionSlug: string,
    target: BidderJob["target"],
): BidderJob {
    return {
        id,
        revision: 1,
        network: "eth",
        collectionId: 1,
        collectionAddress: "0x0000000000000000000000000000000000000001",
        collectionSlug,
        target,
        config: {
            floor: 1n,
            ceiling: 2n,
            delta: 1n,
        },
        state: {},
    };
}

function makeTraitOfferEvent(
    collectionSlug: string,
    traitCriteria: Array<{ type: string; value: string }>,
): MarketEvent {
    const event = new MarketEvent(
        new Date().toISOString(),
        Type.TraitOffer,
        "0xhash",
        collectionSlug,
        "",
        "0xother",
        1,
        "WETH",
        18,
        Scope.Trait,
        traitCriteria,
    );
    event.setTotalPrice(1n);
    return event;
}

describe("bidding runtime helpers", () => {
    it("keeps a retired stream shutdown-visible until its active dispatch drains", async () => {
        const events: string[] = [];
        let releaseDispatch!: () => void;
        const dispatchGate = new Promise<void>((resolve) => {
            releaseDispatch = resolve;
        });
        const bidStreams = new Map([
            [
                "terraforms",
                {
                    stream: {
                        dispose: () => {
                            events.push("stream:dispose");
                        },
                        disposeAndDrain: async () => {
                            events.push("stream:retirement-started");
                            await dispatchGate;
                            events.push("stream:retirement-finished");
                        },
                    },
                },
            ],
        ]);
        const retirement = disposeBiddingRuntimeBidStream(
            bidStreams,
            "terraforms",
        );
        const shutdown = shutdownBiddingRuntime({
            commandAdmissionDrains: [
                async () => {
                    await retirement;
                },
            ],
            bidPipelineDrain: () => {
                events.push("pipeline:drained");
            },
            bidderDrain: () => undefined,
            collectionSnapshotDrain: () => undefined,
            bidBookProjectionDrain: () => undefined,
            independentDrains: [],
            bidStreams,
            disconnectStreamClient: () => undefined,
            stopHeartbeat: () => undefined,
            markStopped: () => undefined,
            setMetricState: () => undefined,
            now: Date.now,
        });

        await new Promise<void>((resolve) => setImmediate(resolve));

        assert.equal(bidStreams.has("terraforms"), true);
        assert.equal(events.includes("pipeline:drained"), false);

        releaseDispatch();
        await shutdown;

        assert.equal(bidStreams.has("terraforms"), false);
        assert.equal(
            events.indexOf("pipeline:drained") >
                events.indexOf("stream:retirement-finished"),
            true,
        );
    });

    it("drains upstream producers before downstream consumers and continues after phase failures", async () => {
        const events: string[] = [];
        const commandFailure = new Error("command drain failed");
        const streamFailure = new Error("stream drain failed");
        const pipelineFailure = new Error("bid pipeline drain failed");
        let releaseStreamDrain: (() => void) | undefined;
        const streamDrainGate = new Promise<void>((resolve) => {
            releaseStreamDrain = resolve;
        });
        const bidStreams = new Map([
            [
                "terraforms",
                {
                    stream: {
                        dispose: () => {
                            events.push("stream:first-dispose");
                        },
                        disposeAndDrain: async () => {
                            events.push("stream:first-drain");
                            throw streamFailure;
                        },
                    },
                },
            ],
            [
                "otherdeed",
                {
                    stream: {
                        dispose: () => {
                            events.push("stream:second-dispose");
                        },
                        disposeAndDrain: async () => {
                            events.push("stream:second-drain-started");
                            await streamDrainGate;
                            events.push("stream:second-drain-settled");
                        },
                    },
                },
            ],
        ]);
        let now = 100;

        const shutdown = shutdownBiddingRuntime({
            commandAdmissionDrains: [
                async () => {
                    events.push("command:rejected");
                    throw commandFailure;
                },
                async () => {
                    events.push("command:sibling-settled");
                },
            ],
            bidPipelineDrain: async () => {
                events.push("pipeline:drained");
                throw pipelineFailure;
            },
            bidderDrain: async () => {
                events.push("bidder:drained");
            },
            collectionSnapshotDrain: async () => {
                events.push("snapshot:drained");
            },
            bidBookProjectionDrain: async () => {
                events.push("projection:drained");
            },
            independentDrains: [
                async () => {
                    events.push("independent:drained");
                },
            ],
            bidStreams,
            disconnectStreamClient: () => {
                events.push("stream-client:disconnect");
            },
            stopHeartbeat: () => {
                events.push("runtime:heartbeat-stopped");
            },
            markStopped: () => {
                events.push("runtime:stopped");
            },
            setMetricState: (state) => {
                events.push(`metric:${state}`);
            },
            now: () => {
                const current = now;
                now += 25;
                return current;
            },
        });

        await new Promise<void>((resolve) => setImmediate(resolve));

        assert.equal(events.includes("command:sibling-settled"), true);
        assert.equal(events.includes("stream:first-drain"), true);
        assert.equal(events.includes("stream:second-drain-started"), true);
        assert.equal(events.includes("stream:second-drain-settled"), false);
        assert.equal(events.includes("pipeline:drained"), false);
        assert.equal(events.includes("bidder:drained"), false);
        assert.equal(bidStreams.size, 2);
        assert.equal(events.includes("stream-client:disconnect"), false);
        assert.equal(events.includes("runtime:stopped"), false);

        releaseStreamDrain?.();
        await assert.rejects(shutdown, (error: unknown) => {
            assert.equal(error instanceof AggregateError, true);
            assert.deepEqual((error as AggregateError).errors, [
                commandFailure,
                streamFailure,
                pipelineFailure,
            ]);
            return true;
        });

        assert.equal(bidStreams.size, 0);
        assert.equal(
            events[0],
            `metric:${BIDDING_RUNTIME_METRIC_STATE.ShuttingDown}`,
        );
        assert.equal(
            events.indexOf("pipeline:drained") >
                events.indexOf("stream:second-drain-settled"),
            true,
        );
        assert.equal(
            events.indexOf("bidder:drained") >
                events.indexOf("pipeline:drained"),
            true,
        );
        assert.equal(
            events.indexOf("snapshot:drained") >
                events.indexOf("bidder:drained"),
            true,
        );
        assert.equal(
            events.indexOf("projection:drained") >
                events.indexOf("snapshot:drained"),
            true,
        );
        assert.equal(
            events.indexOf("independent:drained") >
                events.indexOf("projection:drained"),
            true,
        );
        assert.equal(
            events.indexOf("stream-client:disconnect") >
                events.indexOf("independent:drained"),
            true,
        );
        assert.equal(
            events.indexOf("runtime:stopped") >
                events.indexOf("stream-client:disconnect"),
            true,
        );
    });

    it("continues stream drains, registry cleanup, and disconnect after a subscription dispose failure", async () => {
        const events: string[] = [];
        const disposeFailure = new Error("subscription dispose failed");
        const registryClearFailure = new Error("stream registry clear failed");
        const bidStreams = new Map([
            [
                "terraforms",
                {
                    stream: {
                        dispose: () => {
                            events.push("stream:first-dispose");
                            throw disposeFailure;
                        },
                        disposeAndDrain: async () => {
                            events.push("stream:first-drain");
                        },
                    },
                },
            ],
            [
                "otherdeed",
                {
                    stream: {
                        dispose: () => {
                            events.push("stream:second-dispose");
                        },
                        disposeAndDrain: async () => {
                            events.push("stream:second-drain");
                        },
                    },
                },
            ],
        ]);
        const bidStreamRegistry = {
            values: () => bidStreams.values(),
            clear: () => {
                events.push("stream-registry:clear");
                bidStreams.clear();
                throw registryClearFailure;
            },
        };
        await assert.rejects(
            shutdownBiddingRuntime({
                commandAdmissionDrains: [],
                bidPipelineDrain: async () => undefined,
                bidderDrain: async () => undefined,
                collectionSnapshotDrain: async () => undefined,
                bidBookProjectionDrain: async () => undefined,
                independentDrains: [],
                bidStreams: bidStreamRegistry,
                disconnectStreamClient: () => {
                    events.push("stream-client:disconnect");
                },
                stopHeartbeat: () => {
                    events.push("runtime:heartbeat-stopped");
                },
                markStopped: () => {
                    events.push("runtime:stopped");
                },
                setMetricState: (state) => {
                    events.push(`metric:${state}`);
                },
                now: () => 100,
            }),
            (error: unknown) => {
                assert.equal(error instanceof AggregateError, true);
                assert.deepEqual((error as AggregateError).errors, [
                    disposeFailure,
                    registryClearFailure,
                ]);
                return true;
            },
        );

        assert.equal(events.includes("stream:second-dispose"), true);
        assert.equal(events.includes("stream:first-drain"), true);
        assert.equal(events.includes("stream:second-drain"), true);
        assert.equal(bidStreams.size, 0);
        assert.equal(events.includes("stream-client:disconnect"), true);
        assert.equal(events.includes("runtime:stopped"), true);
        assert.equal(events.at(-1), "runtime:stopped");
    });

    it("passes the explicit dry-run policy into failed-cancellation reconciliation", () => {
        const config = createFailedCancellationReconcilerConfig(
            1,
            300_000,
            true,
        );

        assert.equal(config.chainId, 1);
        assert.equal(config.cancellationRetryMs, 300_000);
        assert.equal(config.dryRun, true);
    });

    it("collects watched collections from all job targets without duplicates", () => {
        const jobs = [
            makeJob("token-a", "terraforms", {
                type: BIDDER_TARGET_TYPE.Token,
                tokenId: "1",
            }),
            makeJob("collection-a", "terraforms", {
                type: BIDDER_TARGET_TYPE.Collection,
                quantity: 1,
            }),
            makeJob("trait-a", "otherdeed", {
                type: BIDDER_TARGET_TYPE.CompetitiveTrait,
                quantity: 1,
                targetTrait: {
                    type: "Environment",
                    value: "Volcanic",
                },
                competitorTraits: [{ type: "Environment" }],
            }),
        ];

        assert.deepEqual(collectWatchedCollectionSlugs(jobs), [
            "terraforms",
            "otherdeed",
        ]);
    });

    it("collects snapshot-backed collections only for token and collection jobs", () => {
        const jobs = [
            makeJob("token-a", "terraforms", {
                type: BIDDER_TARGET_TYPE.Token,
                tokenId: "1",
            }),
            makeJob("collection-a", "otherdeed", {
                type: BIDDER_TARGET_TYPE.Collection,
                quantity: 1,
            }),
            makeJob("trait-a", "grails", {
                type: BIDDER_TARGET_TYPE.CompetitiveTrait,
                quantity: 1,
                targetTrait: {
                    type: "Background",
                    value: "Gold",
                },
                competitorTraits: [{ type: "Background" }],
            }),
        ];

        assert.deepEqual(collectSnapshotBackedCollectionSlugs(jobs), [
            "terraforms",
            "otherdeed",
        ]);
    });

    it("counts token warm candidates from token jobs only", () => {
        const jobs = [
            makeJob("token-a", "terraforms", {
                type: BIDDER_TARGET_TYPE.Token,
                tokenId: "1",
            }),
            makeJob("token-b", "terraforms", {
                type: BIDDER_TARGET_TYPE.Token,
                tokenId: "2",
            }),
            makeJob("collection-a", "otherdeed", {
                type: BIDDER_TARGET_TYPE.Collection,
                quantity: 1,
            }),
        ];

        assert.equal(collectTokenWarmCandidateCount(jobs), 2);
    });

    it("creates snapshot refresh reasons only for watched trait offers", () => {
        const resolver = createCriteriaOfferRefreshReasonResolver({
            terraforms: ["Biome", "Zone"],
        });

        assert.equal(
            resolver(
                makeTraitOfferEvent("terraforms", [
                    { type: "Biome", value: "Shard" },
                    { type: "Level", value: "5" },
                ]),
            ),
            "eventType=trait_offer, matchedTraits=Biome",
        );
        assert.equal(
            resolver(
                makeTraitOfferEvent("terraforms", [
                    { type: "Level", value: "5" },
                ]),
            ),
            null,
        );
        assert.equal(
            resolver(
                makeTraitOfferEvent("otherdeed", [
                    { type: "Biome", value: "Shard" },
                ]),
            ),
            null,
        );
    });

    it("formats OpenSea stream ErrorEvent-like socket errors for structured logs", () => {
        const formatted = formatOpenSeaStreamSocketError({
            type: "error",
            defaultPrevented: false,
            cancelable: false,
            timeStamp: 123.45,
        });

        assert.equal(formatted.detail, "type=error");
        assert.deepEqual(formatted.meta, {
            errorType: "error",
            defaultPrevented: false,
            cancelable: false,
            timeStamp: 123.45,
        });
    });

    it("formats real OpenSea stream errors without relying on object inspection", () => {
        const formatted = formatOpenSeaStreamSocketError(
            new Error("stream disconnected"),
        );

        assert.equal(formatted.detail, "Error: stream disconnected");
        assert.deepEqual(formatted.meta, {
            errorName: "Error",
            errorMessage: "stream disconnected",
        });
    });
});
