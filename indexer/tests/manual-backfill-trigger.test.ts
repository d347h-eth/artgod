import { afterEach, describe, expect, it, vi } from "vitest";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import {
    BACKFILL_ORDER_MAINTENANCE_POLICY,
    BACKFILL_SOURCE,
    SYNC_JOB_KIND,
} from "../src/domain/sync-jobs.js";
import { buildManualHistoricalBackfillJobs } from "../src/application/manual-backfill-trigger.js";

describe("manual backfill trigger jobs", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("builds manual historical backfill jobs with explicit source and policy", () => {
        vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

        const jobs = buildManualHistoricalBackfillJobs({
            chainId: 1,
            collectionId: 42,
            fromBlock: 100,
            toBlock: 104,
            batchSize: 2,
            nonce: "test",
        });

        expect(jobs).toHaveLength(3);
        expect(jobs.map((job) => job.jobId)).toEqual([
            "sync:manual:1:42:100-101:test",
            "sync:manual:1:42:102-103:test",
            "sync:manual:1:42:104-104:test",
        ]);
        expect(jobs).toEqual([
            expect.objectContaining({
                kind: SYNC_JOB_KIND.BackfillRange,
                queue: QUEUE_NAMES.BackfillSync,
                chainId: 1,
                collectionId: 42,
                payload: {
                    fromBlock: 100,
                    toBlock: 101,
                    source: BACKFILL_SOURCE.ManualHistorical,
                    orderMaintenancePolicy:
                        BACKFILL_ORDER_MAINTENANCE_POLICY.SkipGlobalMakerRevalidation,
                },
            }),
            expect.objectContaining({
                payload: expect.objectContaining({
                    fromBlock: 102,
                    toBlock: 103,
                }),
            }),
            expect.objectContaining({
                payload: expect.objectContaining({
                    fromBlock: 104,
                    toBlock: 104,
                }),
            }),
        ]);
    });

    it("omits collection scope for chain-wide manual historical backfill", () => {
        const jobs = buildManualHistoricalBackfillJobs({
            chainId: 1,
            collectionId: null,
            fromBlock: 100,
            toBlock: 100,
            batchSize: 50,
            nonce: "test",
        });

        expect(jobs[0]?.jobId).toBe("sync:manual:1:all:100-100:test");
        expect(jobs[0]?.collectionId).toBeUndefined();
        expect(jobs[0]).toMatchObject({
            chainId: 1,
            kind: SYNC_JOB_KIND.BackfillRange,
        });
    });

    it("rejects invalid ranges before publishing", () => {
        expect(() =>
            buildManualHistoricalBackfillJobs({
                chainId: 1,
                fromBlock: 2,
                toBlock: 1,
                batchSize: 50,
                nonce: "test",
            }),
        ).toThrow("fromBlock must be <= toBlock");
    });
});
