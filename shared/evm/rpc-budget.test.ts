import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    RpcBudgetScheduler,
    RpcBudgetDeferred,
    rpcEndpointBudgetKey,
} from "./rpc-budget.js";
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
    function create(rate = 5, gapRate = 0.5, maxInFlight = 1) {
        budget = new RpcBudgetScheduler(
            ["a", "b"].map((key) => ({
                key,
                limit: { requestsPerSecond: rate, burst: 1 },
            })),
            { requestsPerSecond: gapRate, maxInFlight },
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

    it("zero pauses only gaps, whereas an unlimited endpoint still permits main", async () => {
        create(0, 0);
        await expect(request("gap", WORK.GapRepair)).rejects.toBeInstanceOf(
            RpcBudgetDeferred,
        );
        await expect(request("main")).resolves.toBe("main");
    });

    it("rejects allocations that leave no configured main allowance", () => {
        expect(() => create(1, 1)).toThrow("smaller");
        expect(() => create(5, -1)).toThrow("Invalid");
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
