import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    RpcBudgetScheduler,
    RpcBudgetDeferred,
    rpcEndpointBudgetKey,
    GAP_FILL_MODE,
    type RpcGapAllocation,
} from "./rpc-budget.js";
import {
    RPC_RATE_LIMIT_MODE,
    type RpcRateLimiterConfig,
} from "./rpc-resilience.js";
import {
    SYNC_WORK_CLASS as WORK,
    type SyncWorkClass,
} from "../types/sync-work-class.js";

describe("shared main/gap RPC allocation", () => {
    let budget: RpcBudgetScheduler;
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        budget?.stop();
        vi.useRealTimers();
    });
    function create(
        rate = 5,
        gapRate = 0.5,
        maxInFlight = 1,
        gapMode: RpcGapAllocation["mode"] = GAP_FILL_MODE.Limited,
        rpcMode: RpcRateLimiterConfig["mode"] = RPC_RATE_LIMIT_MODE.Limited,
    ) {
        budget = new RpcBudgetScheduler(
            ["a", "b"].map((key) => ({
                key,
                limit:
                    rpcMode === RPC_RATE_LIMIT_MODE.Limited
                        ? { mode: rpcMode, requestsPerSecond: rate, burst: 1 }
                        : { mode: rpcMode },
            })),
            gapMode === GAP_FILL_MODE.Limited
                ? { mode: gapMode, requestsPerSecond: gapRate, maxInFlight }
                : { mode: gapMode },
            10_000,
        );
        return budget;
    }
    function request(
        id: string,
        workClass: SyncWorkClass = WORK.Main,
        endpointKey = "a",
    ) {
        return budget.acquire({ id, workClass, endpointKey });
    }

    it("lets main use idle gap capacity while retaining a smooth small gap allocation under load", async () => {
        create();
        const order: string[] = [];
        await request("gap-0", WORK.GapRepair);
        budget.release("gap-0");
        const main = Array.from({ length: 20 }, (_, i) =>
            request(`main-${i}`).then((id) => {
                order.push(id);
                budget.release(id);
            }),
        );
        const gap = request("gap-1", WORK.GapRepair).then((id) => {
            order.push(id);
            budget.release(id);
        });
        await vi.advanceTimersByTimeAsync(1_999);
        expect(order.every((id) => id.startsWith("main-"))).toBe(true);
        await vi.advanceTimersByTimeAsync(1);
        await gap;
        expect(order.at(-1)).toBe("gap-1");
        expect(order.filter((id) => id.startsWith("main-"))).toHaveLength(9);
        await vi.advanceTimersByTimeAsync(3_000);
        await Promise.all(main);
    });

    it("never lets idle main work remove the background rate ceiling", async () => {
        create();
        await request("one", WORK.GapRepair);
        budget.release("one");
        let started = false;
        const next = request("two", WORK.GapRepair).then(() => {
            started = true;
        });
        await vi.advanceTimersByTimeAsync(1_999);
        expect(started).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await next;
        expect(started).toBe(true);
    });

    it("shares the in-flight cap across endpoints, releases failures and still admits main", async () => {
        create();
        await request("gap-a", WORK.GapRepair);
        let otherStarted = false;
        const other = request("gap-b", WORK.GapRepair, "b").then(() => {
            otherStarted = true;
        });
        await request("main-b", WORK.Main, "b");
        await vi.advanceTimersByTimeAsync(1_000);
        expect(otherStarted).toBe(false);
        expect(budget.snapshot().gapInFlight).toBe(1);
        budget.release("gap-a");
        await other;
        expect(otherStarted).toBe(true);
        expect(budget.snapshot().gapInFlight).toBe(1);
    });

    it("does not let a slow endpoint stop main requests on another endpoint", async () => {
        create(1, 0.1);
        await request("a-first");
        const blocked = request("a-second");
        await expect(request("b-first", WORK.Main, "b")).resolves.toBe(
            "b-first",
        );
        await vi.advanceTimersByTimeAsync(1_000);
        await blocked;
    });

    it("cancels waiting work without consuming capacity", async () => {
        create();
        await request("active", WORK.GapRepair);
        const waiting = request("cancel", WORK.GapRepair);
        const rejected =
            expect(waiting).rejects.toBeInstanceOf(RpcBudgetDeferred);
        budget.cancel("cancel");
        await rejected;
        expect(budget.snapshot()).toMatchObject({
            gapWaiting: 0,
            gapInFlight: 1,
        });
        budget.release("active");
        expect(budget.snapshot().gapInFlight).toBe(0);
    });

    it("recovers a lost release after its bounded attempt lease expires", async () => {
        create();
        await request("lost", WORK.GapRepair);
        const next = request("next", WORK.GapRepair, "b");
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(next).resolves.toBe("next");
        budget.release("lost");
        expect(budget.snapshot().gapInFlight).toBe(1);
    });

    it.each(Object.values(RPC_RATE_LIMIT_MODE))(
        "disabled gaps retain work while main remains available with %s total capacity",
        async (rpcMode) => {
            create(5, 0.5, 1, GAP_FILL_MODE.Disabled, rpcMode);
            await expect(request("gap", WORK.GapRepair)).rejects.toBeInstanceOf(
                RpcBudgetDeferred,
            );
            await expect(request("main")).resolves.toBe("main");
        },
    );

    it("unlimited gaps remove both local caps while main remains available", async () => {
        create(
            5,
            0.5,
            1,
            GAP_FILL_MODE.Unlimited,
            RPC_RATE_LIMIT_MODE.Unlimited,
        );
        await Promise.all(
            Array.from({ length: 20 }, (_, i) =>
                request(`gap-${i}`, WORK.GapRepair, i % 2 ? "a" : "b"),
            ),
        );
        expect(budget.snapshot().gapInFlight).toBe(20);
        await expect(request("main")).resolves.toBe("main");
        for (let i = 0; i < 20; i++) budget.release(`gap-${i}`);
        expect(budget.snapshot().gapInFlight).toBe(0);
    });

    it("unlimited gaps honor a finite total rate and yield to queued main work", async () => {
        create(5, 0.5, 1, GAP_FILL_MODE.Unlimited);
        await request("active-gap", WORK.GapRepair);
        const order: string[] = [];
        const gap = request("next-gap", WORK.GapRepair).then((id) =>
            order.push(id),
        );
        const main = request("next-main").then((id) => order.push(id));
        await vi.advanceTimersByTimeAsync(199);
        expect(order).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        await main;
        expect(order).toEqual(["next-main"]);
        await vi.advanceTimersByTimeAsync(200);
        await gap;
        expect(order).toEqual(["next-main", "next-gap"]);
        expect(budget.snapshot().gapInFlight).toBe(2);
    });

    it("limited gaps retain their rate and concurrency caps with an unlimited total policy", async () => {
        create(5, 0.5, 1, GAP_FILL_MODE.Limited, RPC_RATE_LIMIT_MODE.Unlimited);
        await request("first", WORK.GapRepair);
        let started = false;
        const next = request("second", WORK.GapRepair, "b").then(() => {
            started = true;
        });
        await vi.advanceTimersByTimeAsync(2_000);
        expect(started).toBe(false);
        await request("main");
        budget.release("first");
        await next;
        expect(budget.snapshot().gapInFlight).toBe(1);
        budget.release("second");
        const sameEndpoint = request("third", WORK.GapRepair, "b");
        await vi.advanceTimersByTimeAsync(1_999);
        expect(budget.snapshot().gapWaiting).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        await sameEndpoint;
    });

    it.each([500, 1500])(
        "sustains 1.5 gap RPS with three permits and %s ms responses",
        async (latency) => {
            create(5, 1.5, 3);
            const times: number[] = [];
            let peak = 0;
            const requests = Array.from({ length: 8 }, (_, i) =>
                request(`latency-${i}`, WORK.GapRepair).then(async (id) => {
                    times.push(Date.now());
                    peak = Math.max(peak, budget.snapshot().gapInFlight);
                    await new Promise((resolve) =>
                        setTimeout(resolve, latency),
                    );
                    budget.release(id);
                }),
            );
            await vi.advanceTimersByTimeAsync(6_500);
            await Promise.all(requests);
            expect(times).toHaveLength(8);
            expect(
                times
                    .slice(1)
                    .every(
                        (time, i) =>
                            time - times[i]! >= 666 && time - times[i]! <= 668,
                    ),
            ).toBe(true);
            expect(peak).toBe(latency === 1500 ? 3 : 1);
        },
    );

    it("rejects allocations that leave no configured main allowance", () => {
        expect(() => create(1, 1)).toThrow("smaller");
        expect(() => create(5, -1)).toThrow("Invalid");
        expect(() => create(5, 0)).toThrow("Invalid");
    });

    it("deduplicates endpoint identity across pools without exposing credentials", () => {
        expect(rpcEndpointBudgetKey("https://example.test")).toBe(
            rpcEndpointBudgetKey("https://example.test/"),
        );
        expect(
            rpcEndpointBudgetKey("https://example.test/?key=secret"),
        ).toMatch(/^[a-f0-9]{64}$/);
        expect(rpcEndpointBudgetKey("https://example.test/?key=a")).not.toBe(
            rpcEndpointBudgetKey("https://example.test/?key=b"),
        );
    });
});
