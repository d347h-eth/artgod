import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "@artgod/shared/utils";
import {
    startOrderValidationDemand,
    ValidateOrderDemand,
    type OrderValidationBatchReport,
} from "../src/application/orders/validate-order-demand.js";
import { ORDER_VALIDATION_DEMAND_POLICY as POLICY } from "../src/domain/order-validation-demand.js";
import { ORDER_PROCESSING_POLICY } from "../src/domain/order-processing.js";
import { FairOrderValidationAdmission } from "../src/infra/orders/fair-validation-admission.js";
import type { OrderValidationDemandPort } from "../src/ports/order-validation-demand.js";

const progressed: OrderValidationBatchReport = {
    scanned: 1,
    claimed: 1,
    validated: 1,
    applied: 1,
    covered: 1,
    resolvedUnneeded: 0,
    followup: 0,
    retried: 0,
    released: 0,
    lostClaims: 0,
    oldestRequiredAt: 0,
    durationMs: 1,
    contractReads: null,
};
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

describe("continuous fair demand scheduling", () => {
    let stop: (() => Promise<void>) | undefined;
    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(logger, "warn").mockImplementation(() => {});
    });
    afterEach(async () => {
        await stop?.();
        stop = undefined;
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("drains ready and obsolete pages promptly, then backs off while idle", async () => {
        const executeBatch = vi.fn(async () =>
            executeBatch.mock.calls.length <= 6
                ? {
                      ...progressed,
                      claimed: 0,
                      validated: 0,
                      applied: 0,
                      covered: 0,
                      resolvedUnneeded: 1,
                  }
                : undefined,
        );
        stop = startOrderValidationDemand({ executeBatch });
        await vi.advanceTimersByTimeAsync(20);
        expect(executeBatch).toHaveBeenCalledTimes(8);
        await vi.advanceTimersByTimeAsync(POLICY.pollMs - 30);
        expect(executeBatch).toHaveBeenCalledTimes(8);
        await vi.advanceTimersByTimeAsync(30);
        expect(executeBatch).toHaveBeenCalledTimes(10);
        await stop();
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(POLICY.pollMs * 2);
        expect(executeBatch).toHaveBeenCalledTimes(10);
    });

    it("holds at most two executions and waits for active work during stop", async () => {
        const gate = deferred();
        const executeBatch = vi.fn(async () => {
            await gate.promise;
            return progressed;
        });
        stop = startOrderValidationDemand({ executeBatch });
        await vi.advanceTimersByTimeAsync(POLICY.pollMs * 3);
        expect(executeBatch).toHaveBeenCalledTimes(
            ORDER_PROCESSING_POLICY.concurrentValidations,
        );
        let stopped = false;
        const stopping = stop().then(() => {
            stopped = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(stopped).toBe(false);
        gate.resolve();
        await stopping;
        expect(vi.getTimerCount()).toBe(0);
    });

    it("backs off polling failures and recovers without stopping the other executor", async () => {
        const executeBatch = vi
            .fn<ValidateOrderDemand["executeBatch"]>()
            .mockRejectedValueOnce(new Error("fixture storage unavailable"))
            .mockResolvedValue(undefined);
        stop = startOrderValidationDemand({ executeBatch });
        await vi.advanceTimersByTimeAsync(POLICY.pollMs - 1);
        expect(executeBatch).toHaveBeenCalledTimes(2);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(executeBatch).toHaveBeenCalledTimes(4);
    });

    it("services waiting maker and token work before demand takes another batch", async () => {
        const admission = new FairOrderValidationAdmission(2);
        const gate = deferred();
        const events: string[] = [];
        let count = 0;
        const executeBatch = vi.fn((signal?: AbortSignal) =>
            admission.run(async () => {
                count++;
                if (count > 2) return undefined;
                events.push("demand");
                await gate.promise;
                return progressed;
            }, signal),
        );
        stop = startOrderValidationDemand({ executeBatch });
        await vi.advanceTimersByTimeAsync(0);
        const maker = admission.run(async () => {
            events.push("maker");
        });
        const token = admission.run(async () => {
            events.push("token");
        });
        gate.resolve();
        await Promise.all([maker, token]);
        expect(events).toEqual(["demand", "demand", "maker", "token"]);
        await vi.advanceTimersByTimeAsync(10);
        expect(executeBatch).toHaveBeenCalledTimes(4);
    });

    it("cancels queued demand on stop before claiming or creating snapshots", async () => {
        const admission = new FairOrderValidationAdmission(2);
        const gate = deferred();
        const holders = [
            admission.run(() => gate.promise),
            admission.run(() => gate.promise),
        ];
        const store: OrderValidationDemandPort = {
            admit: vi.fn(),
            get: vi.fn(),
            claimBatch: vi.fn(),
            renew: vi.fn(),
            completeBatch: vi.fn(),
            release: vi.fn(),
            fail: vi.fn(),
        };
        const createSnapshot = vi.fn();
        stop = startOrderValidationDemand(
            new ValidateOrderDemand({
                chainId: 1,
                store,
                createSnapshot,
                admission,
            }),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(store.claimBatch).not.toHaveBeenCalled();
        await stop();
        expect(logger.warn).not.toHaveBeenCalled();
        gate.resolve();
        await Promise.all(holders);
        expect(store.claimBatch).not.toHaveBeenCalled();
        expect(createSnapshot).not.toHaveBeenCalled();
        await expect(admission.run(async () => "available")).resolves.toBe(
            "available",
        );
    });

    it("removes an aborted waiter while retaining FIFO order and capacity", async () => {
        const admission = new FairOrderValidationAdmission(1);
        const gate = deferred();
        const holder = admission.run(() => gate.promise);
        const controller = new AbortController();
        const work = vi.fn(async () => undefined);
        const cancelled = admission.run(work, controller.signal);
        const rejection = expect(cancelled).rejects.toMatchObject({
            name: "AbortError",
        });
        const next = vi.fn(async () => "next");
        const pending = admission.run(next);
        controller.abort();
        await rejection;
        expect(work).not.toHaveBeenCalled();
        expect(next).not.toHaveBeenCalled();
        gate.resolve();
        await holder;
        await expect(pending).resolves.toBe("next");
        await expect(
            admission.run(work, controller.signal),
        ).rejects.toMatchObject({ name: "AbortError" });
        await expect(admission.run(async () => "free")).resolves.toBe("free");
    });
});
