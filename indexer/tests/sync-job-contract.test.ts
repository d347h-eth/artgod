import { describe, expect, it } from "vitest";
import type { JobEnvelope } from "../src/domain/jobs.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import {
    BACKFILL_ORDER_MAINTENANCE_POLICY as P,
    BACKFILL_SOURCE as S,
    SYNC_JOB_KIND,
    decodeBackfillSyncJob,
} from "../src/domain/sync-jobs.js";

const repair = {
    collectionId: 1,
    repairId: "retained",
    anchorBlock: 100,
    fromBlock: 101,
    toBlock: 110,
};
const payload = {
    fromBlock: 101,
    toBlock: 110,
    source: S.GapRepair,
    orderMaintenancePolicy: P.CurrentState,
    repairs: [repair],
};
function job(value: unknown = payload, collectionId?: number): JobEnvelope {
    return {
        jobId: "fixture",
        kind: SYNC_JOB_KIND.BackfillRange,
        queue: QUEUE_NAMES.BackfillSync,
        chainId: 1,
        attempt: 0,
        scheduledAt: 1,
        collectionId,
        payload: value,
    };
}

describe("backfill sync inbound contract", () => {
    it.each([
        S.ManualHistorical,
        S.BootstrapCatchup,
        S.ReorgRecovery,
        "unknown",
    ])("rejects explicit repair members with source %s", (source) => {
        expect(
            decodeBackfillSyncJob(
                job({
                    ...payload,
                    source,
                    orderMaintenancePolicy:
                        source === S.ManualHistorical
                            ? P.SkipGlobalMakerRevalidation
                            : P.CurrentState,
                    ...(source === S.ReorgRecovery
                        ? { recovery: { recoveryId: "recovery", revision: 1 } }
                        : {}),
                }),
            ),
        ).toBeNull();
    });
    it.each([
        null,
        [],
        {},
        { ...payload, source: undefined },
        { ...payload, fromBlock: -1 },
        { ...payload, toBlock: 100 },
        { ...payload, fromBlock: 1.5 },
        { ...payload, repairs: [] },
        { ...payload, repairs: [repair, repair] },
        { ...payload, repairs: [{ ...repair, anchorBlock: 102 }] },
        { ...payload, repairs: [{ ...repair, toBlock: 111 }] },
        { ...payload, recovery: { recoveryId: "wrong-lane", revision: 1 } },
    ])("rejects invalid range, membership or lane data: %j", (value) => {
        expect(decodeBackfillSyncJob(job(value))).toBeNull();
    });
    it("supports grouped, legacy scoped, manual/bootstrap global/scoped and managed reorg contracts", () => {
        const grouped = job();
        expect(decodeBackfillSyncJob(grouped)).toBe(grouped);
        expect(
            decodeBackfillSyncJob({ ...grouped, collectionId: 1 }),
        ).toBeNull();
        const legacy = { ...payload, repairs: undefined };
        expect(decodeBackfillSyncJob(job(legacy, 1))).not.toBeNull();
        expect(decodeBackfillSyncJob(job(legacy))).toBeNull();
        for (const source of [S.ManualHistorical, S.BootstrapCatchup]) {
            const value = {
                fromBlock: 0,
                toBlock: 110,
                source,
                orderMaintenancePolicy:
                    source === S.ManualHistorical
                        ? P.SkipGlobalMakerRevalidation
                        : P.CurrentState,
            };
            expect(decodeBackfillSyncJob(job(value))).not.toBeNull();
            expect(decodeBackfillSyncJob(job(value, 1))).not.toBeNull();
            expect(decodeBackfillSyncJob(job(value, 0))).toBeNull();
            expect(
                decodeBackfillSyncJob(job({ ...value, recovery: {} })),
            ).toBeNull();
        }
        const reorg = {
            fromBlock: 101,
            toBlock: 110,
            source: S.ReorgRecovery,
            orderMaintenancePolicy: P.CurrentState,
            recovery: { recoveryId: "recovery", revision: 1 },
        };
        expect(decodeBackfillSyncJob(job(reorg))).not.toBeNull();
        expect(decodeBackfillSyncJob(job(reorg, 1))).toBeNull();
        expect(
            decodeBackfillSyncJob(job({ ...reorg, recovery: null })),
        ).toBeNull();
    });
    it("consumes previously retained widened batches without inferring source from their job ID", () => {
        const oldBatch = job({
            ...payload,
            repairs: [repair, { ...repair, collectionId: 2, fromBlock: 110 }],
        });
        expect(decodeBackfillSyncJob(oldBatch)).toBe(oldBatch);
    });
});
