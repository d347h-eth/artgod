import { afterEach, describe, expect, it, vi } from "vitest";
import {
    SYNC_WORK_CLASS,
    type SyncWorkClass,
} from "@artgod/shared/types/sync-work-class";
import { startMetadataPendingPoller } from "../src/application/metadata/pending-poller.js";
import {
    METADATA_PENDING_POLICY as POLICY,
    METADATA_PENDING_METRIC as METRIC,
} from "../src/domain/metadata-pending.js";

afterEach(() => vi.useRealTimers());

describe("metadata pending background pace", () => {
    it("limits each lane to one attempt per poll and stops all timers", async () => {
        vi.useFakeTimers();
        const retryPending = vi.fn(async () => null);
        const workClasses: SyncWorkClass[] = [];
        const workScope = {
            run<T>(workClass: SyncWorkClass, task: () => T): T {
                workClasses.push(workClass);
                return task();
            },
        };
        const stop = startMetadataPendingPoller({
            chainId: 1,
            metadata: {
                retryPending,
                pendingSummary: () => ({
                    pending: 100_000,
                    exhausted: 0,
                    oldestAgeMs: 0,
                }),
            },
            workScope,
            afterWrite: () => {},
        });
        await vi.advanceTimersByTimeAsync(POLICY.pollMs * 3);
        expect(retryPending).toHaveBeenCalledTimes(POLICY.concurrency * 4);
        expect(
            workClasses.every(
                (workClass) => workClass === SYNC_WORK_CLASS.GapRepair,
            ),
        ).toBe(true);
        await stop();
        await vi.advanceTimersByTimeAsync(POLICY.pollMs * 10);
        expect(retryPending).toHaveBeenCalledTimes(POLICY.concurrency * 4);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("never overlaps work inside a lane even when a request takes longer than the cadence", async () => {
        vi.useFakeTimers();
        const release: Array<() => void> = [];
        const retryPending = vi.fn(
            () =>
                new Promise<null>((resolve) =>
                    release.push(() => resolve(null)),
                ),
        );
        const stop = startMetadataPendingPoller({
            chainId: 1,
            metadata: {
                retryPending,
                pendingSummary: () => ({
                    pending: 100_000,
                    exhausted: 0,
                    oldestAgeMs: 0,
                }),
            },
            workScope: { run: (_workClass, task) => task() },
            afterWrite: () => {},
        });
        await vi.advanceTimersByTimeAsync(POLICY.pollMs * 10);
        expect(retryPending).toHaveBeenCalledTimes(POLICY.concurrency);
        const stopped = stop();
        for (const resolve of release) resolve();
        await stopped;
        expect(vi.getTimerCount()).toBe(0);
    });

    it("reports retained exhausted work separately from the active backlog", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(POLICY.renewMs);
        const metrics = {
            increment: vi.fn(),
            gauge: vi.fn(),
            histogram: vi.fn(),
        };
        const stop = startMetadataPendingPoller({
            chainId: 1,
            metadata: {
                retryPending: async () => null,
                pendingSummary: () => ({
                    pending: 3,
                    exhausted: 21,
                    oldestAgeMs: 4_321,
                }),
            },
            metrics,
            workScope: { run: (_workClass, task) => task() },
            afterWrite: () => {},
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(metrics.gauge).toHaveBeenCalledWith(METRIC.Backlog, 3);
        expect(metrics.gauge).toHaveBeenCalledWith(METRIC.Exhausted, 21);
        expect(metrics.gauge).toHaveBeenCalledWith(METRIC.OldestAge, 4_321);
        await stop();
    });
});
