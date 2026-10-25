import type { BootstrapBackfillQueuePort } from "../../application/bootstrap-backfill-executor.js";
import { BOOTSTRAP_BACKFILL_JOB_ID_SCOPE } from "../../domain/bootstrap-jobs.js";
import type { JobEnvelope } from "../../domain/jobs.js";
import { QUEUE_NAMES } from "../../domain/queues.js";
import {
    BACKFILL_SOURCE,
    SYNC_JOB_KIND,
    type BackfillSyncPayload,
} from "../../domain/sync-jobs.js";
import type { QueuePort } from "../../ports/queue.js";

// Bootstrap messages wake the coordinator; retained applied progress owns catch-up.
export async function publishBootstrapBackfillRange(
    queue: Pick<QueuePort, "publish">,
    input: Parameters<BootstrapBackfillQueuePort["scheduleBackfillRange"]>[0],
): Promise<void> {
    const scope = `${BOOTSTRAP_BACKFILL_JOB_ID_SCOPE.Range}:${input.chainId}:${input.collectionId}`;
    const job: JobEnvelope<BackfillSyncPayload> = {
        jobId: `${scope}:${input.fromBlock}-${input.toBlock}`,
        kind: SYNC_JOB_KIND.BackfillRange,
        queue: QUEUE_NAMES.BackfillSync,
        payload: {
            fromBlock: input.fromBlock,
            toBlock: input.toBlock,
            source: BACKFILL_SOURCE.BootstrapCatchup,
        },
        attempt: 0,
        scheduledAt: Date.now(),
        chainId: input.chainId,
        collectionId: input.collectionId,
    };
    await queue.publish(QUEUE_NAMES.BackfillSync, job);
}
