import { describe, expect, it } from "vitest";
import type { JobEnvelope } from "../src/domain/jobs.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import {
    BACKFILL_SOURCE as S,
    SYNC_JOB_KIND,
    decodeBackfillSyncJob,
} from "../src/domain/sync-jobs.js";

const payload = { fromBlock: 0, toBlock: 110, source: S.ManualHistorical };
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

describe("current backfill inbound contract", () => {
    it.each([S.ManualHistorical, S.BootstrapCatchup])(
        "accepts global and collection-scoped %s requests",
        (source) => {
            const request = { ...payload, source };
            for (const scope of [undefined, 1]) {
                const incoming = job(request, scope);
                expect(decodeBackfillSyncJob(incoming)).toBe(incoming);
            }
        },
    );
    it.each([
        null,
        [],
        {},
        { ...payload, source: undefined },
        { ...payload, source: "unknown" },
        { ...payload, source: "gap_repair" },
        { ...payload, source: "reorg_recovery" },
        { ...payload, fromBlock: -1 },
        { ...payload, fromBlock: 111 },
        { ...payload, fromBlock: 1.5 },
        { ...payload, toBlock: Number.POSITIVE_INFINITY },
        { ...payload, toBlock: Number.MAX_SAFE_INTEGER + 1 },
    ])("rejects malformed or unsupported payload %j", (value) => {
        expect(decodeBackfillSyncJob(job(value))).toBeNull();
    });
    it.each([S.ManualHistorical, S.BootstrapCatchup])(
        "rejects automatic authority attached to %s requests",
        (source) => {
            for (const members of [{ repairs: [] }, { recovery: {} }])
                expect(
                    decodeBackfillSyncJob(
                        job({ ...payload, source, ...members }),
                    ),
                ).toBeNull();
        },
    );
    it.each([
        { kind: "unsupported" },
        { queue: QUEUE_NAMES.ActivityDomain },
        { chainId: 0 },
        { chainId: 1.5 },
        { collectionId: 0 },
        { collectionId: 1.5 },
    ])("rejects malformed envelope %j", (fields) => {
        expect(decodeBackfillSyncJob({ ...job(), ...fields })).toBeNull();
    });
});
