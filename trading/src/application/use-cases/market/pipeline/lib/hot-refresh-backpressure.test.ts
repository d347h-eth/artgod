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

function makeEvent(
    type: Type,
    scope: Scope,
    tokenId: string = "",
    traitCriteria: Array<{ type: string; value: string }> = [],
    orderHash: string = "0xhash",
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
    event.setTotalPrice(1n);
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

    it("lets item-scope bid events pass through synchronously", async () => {
        const stage = new HotRefreshBackpressure(
            HOT_REFRESH_BACKPRESSURE_STAGE_NAME.BroadEvents,
            {
                broadCooldownMs: TEST_BROAD_COOLDOWN_MS,
            },
        );
        const calls: Scope[] = [];
        const callback = stage.getWrappingFn()(async (event) => {
            calls.push(event.getScope());
        });

        await callback(makeEvent(Type.ItemReceivedBid, Scope.Item, "123"));

        assert.deepEqual(calls, [Scope.Item]);
    });

    it("coalesces broad events while a collection pass is running", async () => {
        vi.useFakeTimers();
        const stage = new HotRefreshBackpressure(
            HOT_REFRESH_BACKPRESSURE_STAGE_NAME.BroadEvents,
            {
                broadCooldownMs: TEST_BROAD_COOLDOWN_MS,
            },
        );
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

    it("keeps only the latest broad event for the same trait signature", async () => {
        vi.useFakeTimers();
        const stage = new HotRefreshBackpressure(
            HOT_REFRESH_BACKPRESSURE_STAGE_NAME.BroadEvents,
            {
                broadCooldownMs: TEST_BROAD_COOLDOWN_MS,
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
        const first = makeEvent(Type.TraitOffer, Scope.Trait, "", [
            { type: "Biome", value: "53" },
        ]);
        const stale = makeEvent(
            Type.TraitOffer,
            Scope.Trait,
            "",
            [{ type: "Level", value: "10" }],
            "0xstale",
        );
        const latest = makeEvent(
            Type.TraitOffer,
            Scope.Trait,
            "",
            [{ type: "Level", value: "10" }],
            "0xlatest",
        );

        await callback(first);
        await callback(stale);
        await callback(latest);
        releaseFirstPass();
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(TEST_BROAD_COOLDOWN_MS);
        await flushMicrotasks();

        assert.deepEqual(orderHashes, ["0xhash", "0xlatest"]);
    });
});
