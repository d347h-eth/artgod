import type { BootstrapBackfillQueuePort } from "../../application/bootstrap-backfill-executor.js";
import { BOOTSTRAP_BACKFILL_JOB_ID_SCOPE } from "../../domain/bootstrap-jobs.js";
import type { JobEnvelope } from "../../domain/jobs.js";
import { QUEUE_NAMES } from "../../domain/queues.js";
import {
    BACKFILL_ORDER_MAINTENANCE_POLICY,
    BACKFILL_SOURCE,
    SYNC_JOB_KIND,
    type BackfillSyncPayload,
} from "../../domain/sync-jobs.js";
import type { QueuePort } from "../../ports/queue.js";

// Initial ranges retain their deterministic IDs. Recovery IDs are persisted by
// the executor, making a new acquisition distinct from an ACKed initial job.
export async function publishBootstrapBackfillRange(
    queue: Pick<QueuePort, "publish">,
    input: Parameters<BootstrapBackfillQueuePort["scheduleBackfillRange"]>[0],
): Promise<void> {
    const size = Math.max(1, input.batchSize);
    const scope = input.recoveryId
        ? `${BOOTSTRAP_BACKFILL_JOB_ID_SCOPE.Recovery}:${input.chainId}:${input.collectionId}:${input.recoveryId}`
        : `${BOOTSTRAP_BACKFILL_JOB_ID_SCOPE.Range}:${input.chainId}:${input.collectionId}`;
    for (let start = input.fromBlock; start <= input.toBlock; start += size) {
        const end = Math.min(input.toBlock, start + size - 1);
        const job: JobEnvelope<BackfillSyncPayload> = {
            jobId: `${scope}:${start}-${end}`,
            kind: SYNC_JOB_KIND.BackfillRange,
            queue: QUEUE_NAMES.BackfillSync,
            payload: {
                fromBlock: start,
                toBlock: end,
                source: BACKFILL_SOURCE.BootstrapCatchup,
                orderMaintenancePolicy:
                    BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
            },
            attempt: 0,
            scheduledAt: Date.now(),
            chainId: input.chainId,
            collectionId: input.collectionId,
        };
        await queue.publish(QUEUE_NAMES.BackfillSync, job);
    }
}
