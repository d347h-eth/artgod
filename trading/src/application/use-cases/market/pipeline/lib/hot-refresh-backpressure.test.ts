import { strict as assert } from "node:assert";
import { afterEach, describe, it, vi } from "vitest";
import {
    MarketEvent,
    Scope,
    Type,
} from "../../../../../domain/market/event.js";
import {
    HOT_REFRESH_BACKPRESSURE_STAGE_NAME,
    HOT_REFRESH_LANE_KIND,
    HOT_REFRESH_SIGNAL_OUTCOME,
    HotRefreshBackpressure,
    type HotRefreshBackpressureObservabilityPort,
} from "./hot-refresh-backpressure.js";

const TEST_BROAD_COOLDOWN_MS = 1000;
const TEST_ITEM_COOLDOWN_MS = 250;
const TEST_BROAD_MAX_PENDING_SIGNATURES = 8;
const TEST_ITEM_MAX_PENDING_SIGNATURES = 4;
const TEST_UNIQUE_ITEM_LANE_COUNT = 64;
const TEST_MAX_CONCURRENT_PASSES = 2;
const TEST_ITEM_KNOWN_LANE_BOUND =
    TEST_ITEM_MAX_PENDING_SIGNATURES * 2 + TEST_MAX_CONCURRENT_PASSES;
const TEST_ALTERNATING_ITEM_LANE_COUNT = 32;

function makeStage(
    overrides: Partial<{
        broadCooldownMs: number;
        broadMaxPendingSignatures: number;
        itemCooldownMs: number;
        itemMaxPendingSignatures: number;
        maxConcurrentPasses: number;
    }> = {},
    observability?: HotRefreshBackpressureObservabilityPort,
): HotRefreshBackpressure {
    return new HotRefreshBackpressure(
        HOT_REFRESH_BACKPRESSURE_STAGE_NAME.StreamEvents,
        {
            broadCooldownMs: TEST_BROAD_COOLDOWN_MS,
            broadMaxPendingSignatures: TEST_BROAD_MAX_PENDING_SIGNATURES,
            itemCooldownMs: TEST_ITEM_COOLDOWN_MS,
            itemMaxPendingSignatures: TEST_ITEM_MAX_PENDING_SIGNATURES,
            maxConcurrentPasses: TEST_MAX_CONCURRENT_PASSES,
            ...overrides,
        },
        observability,
    );
}

function makeEvent(
    type: Type,
    scope: Scope,
    tokenId: string = "",
    traitCriteria: Array<{ type: string; value: string }> = [],
    orderHash: string = "0xhash",
    unitPrice: bigint = 1n,
): MarketEvent {
    const event = new MarketEvent(
        new Date().toISOString(),
        type,
        orderHash,
        "terraforms",
        tokenId,
        "0xopponent",
        1,
        "WETH",
        18,
        scope,
        traitCriteria,
    );
    event.setTotalPrice(unitPrice);
    return event;
}

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe("HotRefreshBackpressure", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("coalesces repeated item-scope events for the same token", async () => {
        vi.useFakeTimers();
        const signalOutcomes: string[] = [];
        const states: Array<{ activeLanes: number; pendingSignals: number }> =
            [];
        const passes: Array<{ eventCount: number; signalCount: number }> = [];
        const stage = makeStage(
            {},
            {
                onSignal: (input) => signalOutcomes.push(input.outcome),
                onStateChanged: (input) => states.push(input),
                onPassFinished: (input) => passes.push(input),
            },
        );
        const orderHashes: string[] = [];
        let releaseFirstPass!: () => void;
        const firstPassGate = new Promise<void>((resolve) => {
            releaseFirstPass = resolve;
        });
        const callback = stage.getWrappingFn()(async (event) => {
            orderHashes.push(event.getOrderHash());
            if (orderHashes.length === 1) {
                await firstPassGate;
            }
        });

        await callback(
            makeEvent(
                Type.ItemReceivedBid,
                Scope.Item,
                "123",
                [],
                "0xfirst",
                1n,
            ),
        );
        await callback(
            makeEvent(
                Type.ItemReceivedBid,
                Scope.Item,
                "123",
                [],
                "0xlower",
                1n,
            ),
        );
        await callback(
            makeEvent(
                Type.ItemReceivedBid,
                Scope.Item,
                "123",
                [],
                "0xhigher",
                3n,
            ),
        );
        await flushMicrotasks();

        assert.deepEqual(orderHashes, ["0xfirst"]);

        releaseFirstPass();
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(TEST_ITEM_COOLDOWN_MS);
        await flushMicrotasks();

        assert.deepEqual(orderHashes, ["0xfirst", "0xhigher"]);
        assert.deepEqual(signalOutcomes, [
            HOT_REFRESH_SIGNAL_OUTCOME.Queued,
            HOT_REFRESH_SIGNAL_OUTCOME.Queued,
            HOT_REFRESH_SIGNAL_OUTCOME.Coalesced,
        ]);
        assert.ok(states.some((state) => state.activeLanes === 1));
        assert.ok(states.some((state) => state.pendingSignals === 2));
        assert.deepEqual(
            passes.map(({ eventCount, signalCount }) => ({
                eventCount,
                signalCount,
            })),
            [
                { eventCount: 1, signalCount: 1 },
                { eventCount: 1, signalCount: 2 },
            ],
        );
    });

    it("rejects disabled cooldowns", () => {
        assert.throws(
            () =>
                new HotRefreshBackpressure(
                    HOT_REFRESH_BACKPRESSURE_STAGE_NAME.StreamEvents,
                    {
                        broadCooldownMs: 0,
                        broadMaxPendingSignatures:
                            TEST_BROAD_MAX_PENDING_SIGNATURES,
                        itemCooldownMs: TEST_ITEM_COOLDOWN_MS,
                        itemMaxPendingSignatures:
                            TEST_ITEM_MAX_PENDING_SIGNATURES,
                        maxConcurrentPasses: TEST_MAX_CONCURRENT_PASSES,
                    },
                ),
            /broadCooldownMs must be > 0/,
        );
        assert.throws(
            () =>
                new HotRefreshBackpressure(
                    HOT_REFRESH_BACKPRESSURE_STAGE_NAME.StreamEvents,
                    {
                        broadCooldownMs: TEST_BROAD_COOLDOWN_MS,
                        broadMaxPendingSignatures:
                            TEST_BROAD_MAX_PENDING_SIGNATURES,
                        itemCooldownMs: 0,
                        itemMaxPendingSignatures:
                            TEST_ITEM_MAX_PENDING_SIGNATURES,
                        maxConcurrentPasses: TEST_MAX_CONCURRENT_PASSES,
                    },
                ),
            /itemCooldownMs must be > 0/,
        );
        assert.throws(
            () =>
                new HotRefreshBackpressure(
                    HOT_REFRESH_BACKPRESSURE_STAGE_NAME.StreamEvents,
                    {
                        broadCooldownMs: TEST_BROAD_COOLDOWN_MS,
                        broadMaxPendingSignatures: 0,
                        itemCooldownMs: TEST_ITEM_COOLDOWN_MS,
                        itemMaxPendingSignatures:
                            TEST_ITEM_MAX_PENDING_SIGNATURES,
                        maxConcurrentPasses: TEST_MAX_CONCURRENT_PASSES,
                    },
                ),
            /broadMaxPendingSignatures must be an integer > 0/,
        );
        assert.throws(
            () =>
                new HotRefreshBackpressure(
                    HOT_REFRESH_BACKPRESSURE_STAGE_NAME.StreamEvents,
                    {
                        broadCooldownMs: TEST_BROAD_COOLDOWN_MS,
                        broadMaxPendingSignatures:
                            TEST_BROAD_MAX_PENDING_SIGNATURES,
                        itemCooldownMs: TEST_ITEM_COOLDOWN_MS,
                        itemMaxPendingSignatures: 0,
                        maxConcurrentPasses: TEST_MAX_CONCURRENT_PASSES,
                    },
                ),
            /itemMaxPendingSignatures must be an integer > 0/,
        );
        assert.throws(
            () =>
                new HotRefreshBackpressure(
                    HOT_REFRESH_BACKPRESSURE_STAGE_NAME.StreamEvents,
                    {
                        broadCooldownMs: TEST_BROAD_COOLDOWN_MS,
                        broadMaxPendingSignatures:
                            TEST_BROAD_MAX_PENDING_SIGNATURES,
                        itemCooldownMs: TEST_ITEM_COOLDOWN_MS,
                        itemMaxPendingSignatures:
                            TEST_ITEM_MAX_PENDING_SIGNATURES,
                        maxConcurrentPasses: 0,
                    },
                ),
            /maxConcurrentPasses must be an integer > 0/,
        );
    });

    it("ignores late events after stop", async () => {
        const stage = makeStage();
        const calls: Scope[] = [];
        const callback = stage.getWrappingFn()(async (event) => {
            calls.push(event.getScope());
        });

        await stage.stop();
        await callback(makeEvent(Type.ItemReceivedBid, Scope.Item, "123"));
        await callback(makeEvent(Type.CollectionOffer, Scope.Collection));

        assert.deepEqual(calls, []);
    });

    it("keeps processing when every observability callback throws", async () => {
        vi.useFakeTimers();
        const observerFailure = new Error("observer unavailable");
        const stage = makeStage(
            {},
            {
                onSignal: () => {
                    throw observerFailure;
                },
                onStateChanged: () => {
                    throw observerFailure;
                },
                onPassFinished: () => {
                    throw observerFailure;
                },
            },
        );
        const orderHashes: string[] = [];
        const callback = stage.getWrappingFn()(async (event) => {
            orderHashes.push(event.getOrderHash());
        });

        await callback(
            makeEvent(
                Type.ItemReceivedBid,
                Scope.Item,
                "123",
                [],
                "0xprocessed",
            ),
        );
        await flushMicrotasks();
        await stage.stop();

        assert.deepEqual(orderHashes, ["0xprocessed"]);
    });

    it("coalesces broad events while a collection pass is running", async () => {
        vi.useFakeTimers();
        const stage = makeStage();
        const calls: Scope[] = [];
        let releaseFirstPass!: () => void;
        const firstPassGate = new Promise<void>((resolve) => {
            releaseFirstPass = resolve;
        });
        const callback = stage.getWrappingFn()(async (event) => {
            calls.push(event.getScope());
            if (calls.length === 1) {
                await firstPassGate;
            }
        });

        await callback(makeEvent(Type.CollectionOffer, Scope.Collection));
        await callback(
            makeEvent(Type.TraitOffer, Scope.Trait, "", [
                { type: "Biome", value: "53" },
            ]),
        );
        await flushMicrotasks();

        assert.deepEqual(calls, [Scope.Collection]);

        releaseFirstPass();
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(TEST_BROAD_COOLDOWN_MS);
        await flushMicrotasks();

        assert.deepEqual(calls, [Scope.Collection, Scope.Trait]);
    });

    it("discards queued delayed broad work after stop", async () => {
        vi.useFakeTimers();
        const stage = makeStage();
        const orderHashes: string[] = [];
        let releaseFirstPass!: () => void;
        const firstPassGate = new Promise<void>((resolve) => {
            releaseFirstPass = resolve;
        });
        const callback = stage.getWrappingFn()(async (event) => {
            orderHashes.push(event.getOrderHash());
            if (orderHashes.length === 1) {
                await firstPassGate;
            }
        });

        await callback(
            makeEvent(
                Type.CollectionOffer,
                Scope.Collection,
                "",
                [],
                "0xfirst",
            ),
        );
        await flushMicrotasks();

        releaseFirstPass();
        await flushMicrotasks();
        await callback(
            makeEvent(
                Type.CollectionOffer,
                Scope.Collection,
                "",
                [],
                "0xqueued",
            ),
        );
        await stage.stop();
        await vi.advanceTimersByTimeAsync(TEST_BROAD_COOLDOWN_MS);
        await flushMicrotasks();

        assert.deepEqual(orderHashes, ["0xfirst"]);
    });

    it("waits for an active hot-refresh pass to settle during stop", async () => {
        const stage = makeStage();
        let releasePass!: () => void;
        const passGate = new Promise<void>((resolve) => {
            releasePass = resolve;
        });
        const callback = stage.getWrappingFn()(async () => {
            await passGate;
        });

        await callback(makeEvent(Type.CollectionOffer, Scope.Collection));
        await flushMicrotasks();
        let stopped = false;
        const stopPromise = stage.stop().then(() => {
            stopped = true;
        });
        await flushMicrotasks();

        assert.equal(stopped, false);
        releasePass();
        await stopPromise;
        assert.equal(stopped, true);
    });

    it("finishes every captured event in an active pass during stop", async () => {
        vi.useFakeTimers();
        const passResults: boolean[] = [];
        const stage = makeStage(
            {},
            {
                onSignal: () => undefined,
                onStateChanged: () => undefined,
                onPassFinished: ({ succeeded }) => passResults.push(succeeded),
            },
        );
        let releaseInitialPass!: () => void;
        const initialPassGate = new Promise<void>((resolve) => {
            releaseInitialPass = resolve;
        });
        let releaseCapturedPass!: () => void;
        const capturedPassGate = new Promise<void>((resolve) => {
            releaseCapturedPass = resolve;
        });
        const processedOrderHashes: string[] = [];
        const callback = stage.getWrappingFn()(async (event) => {
            processedOrderHashes.push(event.getOrderHash());
            if (event.getOrderHash() === "0xinitial") {
                await initialPassGate;
            }
            if (event.getOrderHash() === "0xcaptured-first") {
                await capturedPassGate;
            }
        });

        await callback(
            makeEvent(
                Type.CollectionOffer,
                Scope.Collection,
                "",
                [],
                "0xinitial",
            ),
        );
        await callback(
            makeEvent(
                Type.TraitOffer,
                Scope.Trait,
                "",
                [{ type: "Biome", value: "53" }],
                "0xcaptured-first",
            ),
        );
        await callback(
            makeEvent(
                Type.TraitOffer,
                Scope.Trait,
                "",
                [{ type: "Level", value: "10" }],
                "0xcaptured-second",
            ),
        );
        releaseInitialPass();
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(TEST_BROAD_COOLDOWN_MS);
        await flushMicrotasks();

        assert.deepEqual(processedOrderHashes, [
            "0xinitial",
            "0xcaptured-first",
        ]);
        let stopped = false;
        const stopPromise = stage.stop().then(() => {
            stopped = true;
        });
        await flushMicrotasks();
        assert.equal(stopped, false);

        releaseCapturedPass();
        await stopPromise;

        assert.deepEqual(processedOrderHashes, [
            "0xinitial",
            "0xcaptured-first",
            "0xcaptured-second",
        ]);
        assert.deepEqual(passResults, [true, true]);
    });

    it("keeps the highest-priced broad event for the same trait signature", async () => {
        vi.useFakeTimers();
        const stage = makeStage();
        const orderHashes: string[] = [];
        let releaseFirstPass!: () => void;
        const firstPassGate = new Promise<void>((resolve) => {
            releaseFirstPass = resolve;
        });
        const callback = stage.getWrappingFn()(async (event) => {
            orderHashes.push(event.getOrderHash());
            if (orderHashes.length === 1) {
                await firstPassGate;
            }
        });
        const first = makeEvent(
            Type.TraitOffer,
            Scope.Trait,
            "",
            [{ type: "Biome", value: "53" }],
            "0xfirst",
        );
        const higher = makeEvent(
            Type.TraitOffer,
            Scope.Trait,
            "",
            [{ type: "Level", value: "10" }],
            "0xhigher",
            3n,
        );
        const lower = makeEvent(
            Type.TraitOffer,
            Scope.Trait,
            "",
            [{ type: "Level", value: "10" }],
            "0xlower",
            1n,
        );

        await callback(first);
        await callback(higher);
        await callback(lower);
        releaseFirstPass();
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(TEST_BROAD_COOLDOWN_MS);
        await flushMicrotasks();

        assert.deepEqual(orderHashes, ["0xfirst", "0xhigher"]);
    });

    it("drops weaker broad signatures when the pending queue is full", async () => {
        vi.useFakeTimers();
        const stage = makeStage({ broadMaxPendingSignatures: 1 });
        const orderHashes: string[] = [];
        let releaseFirstPass!: () => void;
        const firstPassGate = new Promise<void>((resolve) => {
            releaseFirstPass = resolve;
        });
        const callback = stage.getWrappingFn()(async (event) => {
            orderHashes.push(event.getOrderHash());
            if (orderHashes.length === 1) {
                await firstPassGate;
            }
        });

        await callback(
            makeEvent(
                Type.TraitOffer,
                Scope.Trait,
                "",
                [{ type: "Biome", value: "53" }],
                "0xfirst",
                1n,
            ),
        );
        await callback(
            makeEvent(
                Type.TraitOffer,
                Scope.Trait,
                "",
                [{ type: "Level", value: "10" }],
                "0xkept",
                5n,
            ),
        );
        await callback(
            makeEvent(
                Type.TraitOffer,
                Scope.Trait,
                "",
                [{ type: "Mode", value: "Terrain" }],
                "0xdropped",
                2n,
            ),
        );

        releaseFirstPass();
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(TEST_BROAD_COOLDOWN_MS);
        await flushMicrotasks();

        assert.deepEqual(orderHashes, ["0xfirst", "0xkept"]);
    });

    it("evicts weaker broad signatures for stronger pending signals", async () => {
        vi.useFakeTimers();
        const broadStates: Array<{
            pendingEvents: number;
            pendingSignals: number;
        }> = [];
        const passSignalCounts: number[] = [];
        const stage = makeStage(
            { broadMaxPendingSignatures: 1 },
            {
                onSignal: () => undefined,
                onStateChanged: (input) => {
                    if (input.laneKind === HOT_REFRESH_LANE_KIND.Broad) {
                        broadStates.push(input);
                    }
                },
                onPassFinished: (input) =>
                    passSignalCounts.push(input.signalCount),
            },
        );
        const orderHashes: string[] = [];
        let releaseFirstPass!: () => void;
        const firstPassGate = new Promise<void>((resolve) => {
            releaseFirstPass = resolve;
        });
        const callback = stage.getWrappingFn()(async (event) => {
            orderHashes.push(event.getOrderHash());
            if (orderHashes.length === 1) {
                await firstPassGate;
            }
        });

        await callback(
            makeEvent(
                Type.TraitOffer,
                Scope.Trait,
                "",
                [{ type: "Biome", value: "53" }],
                "0xfirst",
                1n,
            ),
        );
        await callback(
            makeEvent(
                Type.TraitOffer,
                Scope.Trait,
                "",
                [{ type: "Level", value: "10" }],
                "0xevicted",
                2n,
            ),
        );
        await callback(
            makeEvent(
                Type.TraitOffer,
                Scope.Trait,
                "",
                [{ type: "Mode", value: "Terrain" }],
                "0xstronger",
                5n,
            ),
        );

        assert.deepEqual(broadStates.at(-1), {
            laneKind: HOT_REFRESH_LANE_KIND.Broad,
            activeLanes: 1,
            knownLanes: 1,
            pendingEvents: 1,
            pendingSignals: 1,
        });

        releaseFirstPass();
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(TEST_BROAD_COOLDOWN_MS);
        await flushMicrotasks();

        assert.deepEqual(orderHashes, ["0xfirst", "0xstronger"]);
        assert.deepEqual(passSignalCounts, [1, 1]);
    });

    it("bounds active and pending pressure during a blocked unique-item flood", async () => {
        vi.useFakeTimers();
        const itemStates: Array<{
            activeLanes: number;
            knownLanes: number;
            pendingEvents: number;
            pendingSignals: number;
        }> = [];
        const signalOutcomes: string[] = [];
        const stage = makeStage(
            {},
            {
                onSignal: (input) => signalOutcomes.push(input.outcome),
                onStateChanged: (input) => {
                    if (input.laneKind === HOT_REFRESH_LANE_KIND.Item) {
                        itemStates.push(input);
                    }
                },
                onPassFinished: () => undefined,
            },
        );
        const warmCooldownCallback = stage.getWrappingFn()(
            async () => undefined,
        );
        for (
            let index = 0;
            index < TEST_ITEM_MAX_PENDING_SIGNATURES;
            index += 1
        ) {
            await warmCooldownCallback(
                makeEvent(Type.ItemReceivedBid, Scope.Item, `warm-${index}`),
            );
        }
        await flushMicrotasks();
        let releasePasses!: () => void;
        const passGate = new Promise<void>((resolve) => {
            releasePasses = resolve;
        });
        const processedOrderHashes: string[] = [];
        const callback = stage.getWrappingFn()(async (event) => {
            processedOrderHashes.push(event.getOrderHash());
            await passGate;
        });

        for (let index = 0; index < TEST_UNIQUE_ITEM_LANE_COUNT; index += 1) {
            await callback(
                makeEvent(
                    Type.ItemReceivedBid,
                    Scope.Item,
                    String(index),
                    [],
                    `0xflood-${index}`,
                    BigInt(index + 1),
                ),
            );
        }
        await callback(
            makeEvent(
                Type.ItemReceivedBid,
                Scope.Item,
                String(TEST_UNIQUE_ITEM_LANE_COUNT),
                [],
                "0xdropped-new-lane",
                1n,
            ),
        );

        assert.deepEqual(itemStates.at(-1), {
            laneKind: HOT_REFRESH_LANE_KIND.Item,
            activeLanes: TEST_MAX_CONCURRENT_PASSES,
            knownLanes: TEST_ITEM_KNOWN_LANE_BOUND,
            pendingEvents: TEST_ITEM_MAX_PENDING_SIGNATURES,
            pendingSignals: TEST_ITEM_MAX_PENDING_SIGNATURES,
        });
        assert.ok(
            itemStates.every(
                (state) => state.knownLanes <= TEST_ITEM_KNOWN_LANE_BOUND,
            ),
        );
        assert.equal(
            signalOutcomes.filter(
                (outcome) => outcome === HOT_REFRESH_SIGNAL_OUTCOME.Evicted,
            ).length,
            TEST_UNIQUE_ITEM_LANE_COUNT -
                TEST_MAX_CONCURRENT_PASSES -
                TEST_ITEM_MAX_PENDING_SIGNATURES,
        );
        assert.equal(
            signalOutcomes.filter(
                (outcome) => outcome === HOT_REFRESH_SIGNAL_OUTCOME.Dropped,
            ).length,
            1,
        );

        releasePasses();
        await flushMicrotasks();
        await flushMicrotasks();
        await flushMicrotasks();

        assert.deepEqual(itemStates.at(-1), {
            laneKind: HOT_REFRESH_LANE_KIND.Item,
            activeLanes: 0,
            knownLanes: TEST_ITEM_MAX_PENDING_SIGNATURES,
            pendingEvents: 0,
            pendingSignals: 0,
        });
        assert.deepEqual(
            processedOrderHashes.slice(-TEST_ITEM_MAX_PENDING_SIGNATURES),
            Array.from(
                { length: TEST_ITEM_MAX_PENDING_SIGNATURES },
                (_, offset) =>
                    `0xflood-${
                        TEST_UNIQUE_ITEM_LANE_COUNT -
                        TEST_ITEM_MAX_PENDING_SIGNATURES +
                        offset
                    }`,
            ),
        );

        await vi.advanceTimersByTimeAsync(TEST_ITEM_COOLDOWN_MS);
        await flushMicrotasks();

        assert.deepEqual(itemStates.at(-1), {
            laneKind: HOT_REFRESH_LANE_KIND.Item,
            activeLanes: 0,
            knownLanes: 0,
            pendingEvents: 0,
            pendingSignals: 0,
        });
    });

    it("bounds cooldown retention during a fast unique-item burst", async () => {
        vi.useFakeTimers();
        const itemStates: Array<{
            activeLanes: number;
            knownLanes: number;
            pendingEvents: number;
            pendingSignals: number;
        }> = [];
        const stage = makeStage(
            {},
            {
                onSignal: () => undefined,
                onStateChanged: (input) => {
                    if (input.laneKind === HOT_REFRESH_LANE_KIND.Item) {
                        itemStates.push(input);
                    }
                },
                onPassFinished: () => undefined,
            },
        );
        const callback = stage.getWrappingFn()(async () => undefined);

        for (let index = 0; index < TEST_UNIQUE_ITEM_LANE_COUNT; index += 1) {
            await callback(
                makeEvent(Type.ItemReceivedBid, Scope.Item, String(index)),
            );
        }
        await flushMicrotasks();

        assert.deepEqual(itemStates.at(-1), {
            laneKind: HOT_REFRESH_LANE_KIND.Item,
            activeLanes: 0,
            knownLanes: TEST_ITEM_MAX_PENDING_SIGNATURES,
            pendingEvents: 0,
            pendingSignals: 0,
        });
        assert.ok(
            itemStates.every(
                (state) => state.knownLanes <= TEST_ITEM_KNOWN_LANE_BOUND,
            ),
        );

        await vi.advanceTimersByTimeAsync(TEST_ITEM_COOLDOWN_MS);
        await flushMicrotasks();

        assert.deepEqual(itemStates.at(-1), {
            laneKind: HOT_REFRESH_LANE_KIND.Item,
            activeLanes: 0,
            knownLanes: 0,
            pendingEvents: 0,
            pendingSignals: 0,
        });
    });

    it("re-retires delayed lanes emptied by stronger unique signals", async () => {
        vi.useFakeTimers();
        const itemStates: Array<{
            knownLanes: number;
        }> = [];
        const signalOutcomes: string[] = [];
        const stage = makeStage(
            {
                itemMaxPendingSignatures: 1,
                maxConcurrentPasses: 1,
            },
            {
                onSignal: (input) => signalOutcomes.push(input.outcome),
                onStateChanged: (input) => {
                    if (input.laneKind === HOT_REFRESH_LANE_KIND.Item) {
                        itemStates.push(input);
                    }
                },
                onPassFinished: () => undefined,
            },
        );
        const processedOrderHashes: string[] = [];
        const callback = stage.getWrappingFn()(async (event) => {
            processedOrderHashes.push(event.getOrderHash());
        });
        await callback(
            makeEvent(
                Type.ItemReceivedBid,
                Scope.Item,
                "0",
                [],
                "0xinitial",
                1n,
            ),
        );
        await flushMicrotasks();

        for (
            let index = 0;
            index < TEST_ALTERNATING_ITEM_LANE_COUNT;
            index += 1
        ) {
            await callback(
                makeEvent(
                    Type.ItemReceivedBid,
                    Scope.Item,
                    String(index),
                    [],
                    `0xdelayed-${index}`,
                    BigInt(index + 1),
                ),
            );
            await callback(
                makeEvent(
                    Type.ItemReceivedBid,
                    Scope.Item,
                    String(index + 1),
                    [],
                    `0xstronger-${index + 1}`,
                    BigInt(index + 2),
                ),
            );
            await flushMicrotasks();
        }

        assert.equal(
            signalOutcomes.filter(
                (outcome) => outcome === HOT_REFRESH_SIGNAL_OUTCOME.Evicted,
            ).length,
            TEST_ALTERNATING_ITEM_LANE_COUNT,
        );
        assert.equal(processedOrderHashes.includes("0xdelayed-0"), false);
        assert.ok(itemStates.every((state) => state.knownLanes <= 2));
        assert.equal(itemStates.at(-1)?.knownLanes, 1);

        await vi.advanceTimersByTimeAsync(TEST_ITEM_COOLDOWN_MS);
        await flushMicrotasks();

        assert.equal(itemStates.at(-1)?.knownLanes, 0);
    });

    it("forgets the oldest cooldown when unique identity pressure is full", async () => {
        vi.useFakeTimers();
        const stage = makeStage({
            itemMaxPendingSignatures: 1,
            maxConcurrentPasses: 1,
        });
        const processedOrderHashes: string[] = [];
        const callback = stage.getWrappingFn()(async (event) => {
            processedOrderHashes.push(event.getOrderHash());
        });

        await callback(
            makeEvent(Type.ItemReceivedBid, Scope.Item, "1", [], "0xoldest"),
        );
        await flushMicrotasks();
        await callback(
            makeEvent(Type.ItemReceivedBid, Scope.Item, "2", [], "0xnewest"),
        );
        await flushMicrotasks();
        await callback(
            makeEvent(
                Type.ItemReceivedBid,
                Scope.Item,
                "1",
                [],
                "0xoldest-repeated",
            ),
        );
        await flushMicrotasks();

        assert.deepEqual(processedOrderHashes, [
            "0xoldest",
            "0xnewest",
            "0xoldest-repeated",
        ]);
    });
});
