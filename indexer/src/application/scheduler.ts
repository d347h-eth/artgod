import { logger } from "@artgod/shared/utils";
import type { IndexerConfig } from "../config/index.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import type {
    BackfillSyncPayload,
    RealtimeSyncPayload,
} from "../domain/sync-jobs.js";
import { SYNC_JOB_KIND } from "../domain/sync-jobs.js";
import type { JobEnvelope } from "../domain/jobs.js";
import type { HeadSourcePort } from "../ports/head-source.js";
import type { QueuePort } from "../ports/queue.js";
import type { RpcProviderPort } from "../ports/rpc.js";
import { REORG_JOB_KIND, type BlockCheckPayload } from "../domain/reorg-jobs.js";

export type SchedulerOptions = {
    pollIntervalMs?: number;
    headSource?: HeadSourcePort;
};

// Scheduler runtime: perform a blocking bootstrap (head fetch + initial schedule),
// then start non-blocking WS/poller loops that enqueue new heads in the background.
export async function startScheduler(
    rpc: RpcProviderPort,
    queue: QueuePort,
    config: IndexerConfig,
    options: SchedulerOptions = {},
): Promise<() => Promise<void>> {
    const pollIntervalMs = options.pollIntervalMs ?? 12_000;
    const reorgDepth = Math.max(1, config.sync.reorgDepth);
    // lastScheduled is set after bootstrap so polling never schedules from "undefined".
    let lastScheduled: number | null = null;
    let lastChecked = -1;
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let stopHeadSource: (() => Promise<void>) | undefined;

    if (config.collections.length === 0) {
        logger.warn("No target collections configured", {
            component: "IndexerScheduler",
            action: "start",
        });
    }

    await bootstrapRealtimeScheduling();
    await bootstrapBlockChecks();

    const handleHead = async (headNumber: number) => {
        // Ignore head events until bootstrap completed.
        if (lastScheduled === null || headNumber <= lastScheduled) return;

        await scheduleRealtimeForHead(headNumber);
        await scheduleBlockChecksForHead(headNumber);
    };

    if (options.headSource) {
        // Non-blocking: WS head listener pushes new heads into the scheduler.
        stopHeadSource = await options.headSource.start(
            (headNumber) => {
                logger.debug("Scheduler WS head received", {
                    component: "IndexerScheduler",
                    action: "wsHead",
                    headNumber,
                });
                handleHead(headNumber).catch((err) => {
                    logger.warn("Scheduler WS head failed", {
                        component: "IndexerScheduler",
                        action: "wsHead",
                        error: String(err),
                    });
                });
            },
            (error) => {
                logger.warn("Scheduler WS listener error", {
                    component: "IndexerScheduler",
                    action: "wsHead",
                    error: String(error),
                });
            },
        );
    }

    const poll = async () => {
        if (stopped) return;
        // Poller is authoritative and fills any gaps missed by the WS path.
        const current = await rpc.getBlockNumber();
        logger.debug("Scheduler poll head received", {
            component: "IndexerScheduler",
            action: "poll",
            headNumber: current,
        });
        await handleHead(current);
    };

    // Non-blocking: the timer drives polling while the caller continues.
    timer = setInterval(() => {
        poll().catch((err) => {
            logger.warn("Scheduler poll failed", {
                component: "IndexerScheduler",
                action: "poll",
                error: String(err),
            });
        });
    }, pollIntervalMs);

    return async () => {
        stopped = true;
        if (timer) clearInterval(timer);
        if (stopHeadSource) {
            await stopHeadSource();
        }
    };

    async function bootstrapRealtimeScheduling(): Promise<void> {
        // Bootstrap: schedule only the recent reorg window, never full history.
        // This blocking step ensures the first scheduled range is based on a known head.
        const head = await rpc.getBlockNumber();
        const start = getRealtimeWindowStart(head, reorgDepth);
        await scheduleRealtimeRange(queue, config.chainId, start, head);
        lastScheduled = head;
    }

    async function bootstrapBlockChecks(): Promise<void> {
        // Separate bootstrap for reorg checks to keep scheduling intent explicit.
        if (lastScheduled === null) return;
        const initialCheck = getReorgCheckBlock(lastScheduled, reorgDepth);
        if (initialCheck <= 0) {
            logger.warn("Scheduler block-check bootstrap skipped", {
                component: "IndexerScheduler",
                action: "bootstrapBlockChecks",
                initialCheck,
            });
            lastChecked = initialCheck;
            return;
        }
        await scheduleBlockCheck(queue, config.chainId, initialCheck);
        lastChecked = initialCheck;
    }

    async function scheduleRealtimeForHead(headNumber: number): Promise<void> {
        // Schedule only the new head range; dedupe happens at the broker via jobId.
        if (lastScheduled === null) return;
        await scheduleRealtimeRange(
            queue,
            config.chainId,
            lastScheduled + 1,
            headNumber,
        );
        lastScheduled = headNumber;
    }

    async function scheduleBlockChecksForHead(headNumber: number): Promise<void> {
        const targetCheck = getReorgCheckBlock(headNumber, reorgDepth);
        if (targetCheck < 0) return;
        const startCheck = lastChecked + 1;
        if (startCheck <= 0) {
            logger.warn("Scheduler block-check range skipped", {
                component: "IndexerScheduler",
                action: "scheduleBlockChecksForHead",
                startCheck,
                targetCheck,
            });
            lastChecked = targetCheck;
            return;
        }
        for (let block = startCheck; block <= targetCheck; block += 1) {
            await scheduleBlockCheck(queue, config.chainId, block);
        }
        lastChecked = targetCheck;
    }
}

async function scheduleRealtimeRange(
    queue: QueuePort,
    chainId: number,
    fromBlock: number,
    toBlock: number,
): Promise<void> {
    // Emit one job per block so workers can process independently and idempotently.
    for (let block = fromBlock; block <= toBlock; block += 1) {
        const job: JobEnvelope<RealtimeSyncPayload> = {
            jobId: `sync:realtime:${chainId}:${block}`,
            kind: SYNC_JOB_KIND.RealtimeBlock,
            queue: QUEUE_NAMES.RealtimeSync,
            payload: { blockNumber: block },
            attempt: 0,
            scheduledAt: Date.now(),
            chainId,
        };
        await queue.publish(QUEUE_NAMES.RealtimeSync, job);
    }
}

async function scheduleBackfillRange(
    queue: QueuePort,
    chainId: number,
    fromBlock: number,
    toBlock: number,
    batchSize: number,
): Promise<void> {
    // Manual backfill path: emit batched range jobs when explicitly requested.
    const size = Math.max(1, batchSize);
    for (let start = fromBlock; start <= toBlock; start += size) {
        const end = Math.min(toBlock, start + size - 1);
        const job: JobEnvelope<BackfillSyncPayload> = {
            jobId: `sync:backfill:${chainId}:${start}-${end}`,
            kind: SYNC_JOB_KIND.BackfillRange,
            queue: QUEUE_NAMES.BackfillSync,
            payload: { fromBlock: start, toBlock: end },
            attempt: 0,
            scheduledAt: Date.now(),
            chainId,
        };
        await queue.publish(QUEUE_NAMES.BackfillSync, job);
    }
}

async function scheduleBlockCheck(
    queue: QueuePort,
    chainId: number,
    blockNumber: number,
): Promise<void> {
    const job: JobEnvelope<BlockCheckPayload> = {
        jobId: `reorg:check:${chainId}:${blockNumber}`,
        kind: REORG_JOB_KIND.BlockCheck,
        queue: QUEUE_NAMES.BlockCheck,
        payload: { blockNumber },
        attempt: 0,
        scheduledAt: Date.now(),
        chainId,
    };
    await queue.publish(QUEUE_NAMES.BlockCheck, job);
}

function getRealtimeWindowStart(head: number, depth: number): number {
    // Avoid scheduling from very low blocks on bootstrap; clamp to head if depth exceeds chain height.
    return head < depth ? head : head - depth + 1;
}

function getReorgCheckBlock(head: number, depth: number): number {
    return head - depth + 1;
}
