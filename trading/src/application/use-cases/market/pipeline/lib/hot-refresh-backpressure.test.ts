import { strict as assert } from "node:assert";
import { afterEach, describe, it, vi } from "vitest";
import {
    MarketEvent,
    Scope,
    Type,
} from "../../../../../domain/market/event.js";
import {
    HOT_REFRESH_BACKPRESSURE_STAGE_NAME,
    HotRefreshBackpressure,
} from "./hot-refresh-backpressure.js";

const TEST_BROAD_COOLDOWN_MS = 1000;
const TEST_ITEM_COOLDOWN_MS = 250;
const TEST_BROAD_MAX_PENDING_SIGNATURES = 8;
const TEST_ITEM_MAX_PENDING_SIGNATURES = 4;

function makeStage(
    overrides: Partial<{
        broadCooldownMs: number;
        broadMaxPendingSignatures: number;
        itemCooldownMs: number;
        itemMaxPendingSignatures: number;
    }> = {},
): HotRefreshBackpressure {
    return new HotRefreshBackpressure(
        HOT_REFRESH_BACKPRESSURE_STAGE_NAME.StreamEvents,
        {
            broadCooldownMs: TEST_BROAD_COOLDOWN_MS,
            broadMaxPendingSignatures: TEST_BROAD_MAX_PENDING_SIGNATURES,
            itemCooldownMs: TEST_ITEM_COOLDOWN_MS,
            itemMaxPendingSignatures: TEST_ITEM_MAX_PENDING_SIGNATURES,
            ...overrides,
        },
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
                    },
                ),
            /itemMaxPendingSignatures must be an integer > 0/,
        );
    });

    it("ignores late events after stop", async () => {
        const stage = makeStage();
        const calls: Scope[] = [];
        const callback = stage.getWrappingFn()(async (event) => {
            calls.push(event.getScope());
        });

        stage.stop();
        await callback(makeEvent(Type.ItemReceivedBid, Scope.Item, "123"));
        await callback(makeEvent(Type.CollectionOffer, Scope.Collection));

        assert.deepEqual(calls, []);
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
        stage.stop();
        await vi.advanceTimersByTimeAsync(TEST_BROAD_COOLDOWN_MS);
        await flushMicrotasks();

        assert.deepEqual(orderHashes, ["0xfirst"]);
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

        releaseFirstPass();
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(TEST_BROAD_COOLDOWN_MS);
        await flushMicrotasks();

        assert.deepEqual(orderHashes, ["0xfirst", "0xstronger"]);
    });
});
