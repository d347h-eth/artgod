import {
    BACKFILL_ORDER_MAINTENANCE_POLICY,
    BACKFILL_SOURCE,
    SYNC_JOB_KIND,
    type BackfillSyncPayload,
} from "../domain/sync-jobs.js";
import type { JobEnvelope } from "../domain/jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";

export type ManualHistoricalBackfillInput = {
    chainId: number;
    fromBlock: number;
    toBlock: number;
    batchSize: number;
    collectionId?: number | null;
    nonce: string | number;
};

// Builds manual historical backfill jobs with explicit source/policy contract.
export function buildManualHistoricalBackfillJobs(
    input: ManualHistoricalBackfillInput,
): Array<JobEnvelope<BackfillSyncPayload>> {
    assertBlockNumber(input.fromBlock, "fromBlock");
    assertBlockNumber(input.toBlock, "toBlock");
    if (input.fromBlock > input.toBlock) {
        throw new Error("fromBlock must be <= toBlock");
    }
    const batchSize = parsePositiveInteger(input.batchSize, "batchSize");
    const chainId = parsePositiveInteger(input.chainId, "chainId");
    const collectionId =
        input.collectionId === null || input.collectionId === undefined
            ? null
            : parsePositiveInteger(input.collectionId, "collectionId");
    const jobs: Array<JobEnvelope<BackfillSyncPayload>> = [];
    for (let start = input.fromBlock; start <= input.toBlock; start += batchSize) {
        const end = Math.min(input.toBlock, start + batchSize - 1);
        const scope = collectionId ?? "all";
        jobs.push({
            jobId: `sync:manual:${chainId}:${scope}:${start}-${end}:${input.nonce}`,
            kind: SYNC_JOB_KIND.BackfillRange,
            queue: QUEUE_NAMES.BackfillSync,
            payload: {
                fromBlock: start,
                toBlock: end,
                source: BACKFILL_SOURCE.ManualHistorical,
                orderMaintenancePolicy:
                    BACKFILL_ORDER_MAINTENANCE_POLICY.SkipGlobalMakerRevalidation,
            },
            attempt: 0,
            scheduledAt: Date.now(),
            chainId,
            collectionId: collectionId ?? undefined,
        });
    }
    return jobs;
}

function assertBlockNumber(value: number, field: string): void {
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`${field} must be a block number`);
    }
}

function parsePositiveInteger(value: number, field: string): number {
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${field} must be a positive integer`);
    }
    return value;
}
