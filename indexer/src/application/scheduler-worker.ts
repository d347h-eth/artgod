import { logger } from "@artgod/shared/utils";
import type { IndexerConfig } from "../config/index.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import type { RealtimeSyncPayload } from "../domain/sync-jobs.js";
import { SYNC_JOB_KIND } from "../domain/sync-jobs.js";
import type { JobEnvelope } from "../domain/jobs.js";
import type { HeadSourcePort } from "../ports/head-source.js";
import type { QueuePort } from "../ports/queue.js";
import type { RpcProviderPort } from "../ports/rpc.js";
import { NOOP_APM, type ApmPort } from "@artgod/shared/observability/apm";
import {
    REORG_JOB_KIND,
    type BlockCheckPayload,
} from "../domain/reorg-jobs.js";

export type SchedulerWorkerOptions = {
    pollIntervalMs?: number;
    headSource?: HeadSourcePort;
    apm?: ApmPort;
};

// Scheduler-worker runtime: perform a blocking bootstrap (head fetch + initial schedule),
// then start non-blocking WS/poller loops that enqueue new heads in the background.
export async function startSchedulerWorker(
    rpc: Pick<RpcProviderPort, "getBlockNumber">,
    queue: Pick<QueuePort, "publish">,
    config: {
        chainId: IndexerConfig["chainId"];
        sync: Pick<IndexerConfig["sync"], "reorgDepth">;
    },
    options: SchedulerWorkerOptions = {},
): Promise<() => Promise<void>> {
    const pollIntervalMs = options.pollIntervalMs ?? 12_000;
    const reorgDepth = Math.max(1, config.sync.reorgDepth);
    const apm = options.apm ?? NOOP_APM;
    // lastScheduled is set after bootstrap so polling never schedules from "undefined".
    let lastScheduled: number | null = null;
    let lastChecked = -1;
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let stopHeadSource: (() => Promise<void>) | undefined;
    let headWork: Promise<void> = Promise.resolve();
    let pollWork: Promise<void> | null = null;

    await bootstrapRealtimeScheduling();
    await bootstrapBlockChecks();

    const handleHead = (headNumber: number): Promise<void> => {
        if (stopped) return Promise.resolve();
        // WS and HTTP publications share one cursor. Serialize their updates so
        // a slower, older head cannot move that cursor backward.
        const next = headWork.then(async () => {
            if (stopped || lastScheduled === null) return;
            if (headNumber > lastScheduled)
                await scheduleRealtimeForHead(headNumber);
            // Retry interrupted block-check fanout even if the head is unchanged.
            await scheduleBlockChecksForHead(headNumber);
        });
        headWork = next.catch(() => {});
        return next;
    };

    if (options.headSource) {
        // Non-blocking: WS head listener pushes new heads into the scheduler-worker.
        stopHeadSource = await options.headSource.start(
            (headNumber) => {
                logger.debug("Scheduler-worker WS head received", {
                    component: "IndexerSchedulerWorker",
                    action: "wsHead",
                    headNumber,
                });
                apm.withSpan(
                    "scheduler-worker.head.ws",
                    {
                        chainId: config.chainId,
                        headNumber,
                    },
                    () => handleHead(headNumber),
                ).catch((err) => {
                    logger.warn("Scheduler-worker WS head failed", {
                        component: "IndexerSchedulerWorker",
                        action: "wsHead",
                        error: String(err),
                    });
                });
            },
            (error) => {
                logger.warn("Scheduler-worker WS listener error", {
                    component: "IndexerSchedulerWorker",
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
        logger.debug("Scheduler-worker poll head received", {
            component: "IndexerSchedulerWorker",
            action: "poll",
            headNumber: current,
        });
        await apm.withSpan(
            "scheduler-worker.head.poll",
            {
                chainId: config.chainId,
                headNumber: current,
            },
            () => handleHead(current),
        );
    };

    // Non-blocking: the timer drives polling while the caller continues.
    timer = setInterval(() => {
        if (stopped || pollWork) return;
        pollWork = poll()
            .catch((err) => {
                logger.warn("Scheduler-worker poll failed", {
                    component: "IndexerSchedulerWorker",
                    action: "poll",
                    error: String(err),
                });
            })
            .finally(() => {
                pollWork = null;
            });
    }, pollIntervalMs);

    return async () => {
        stopped = true;
        if (timer) clearInterval(timer);
        if (stopHeadSource) {
            await stopHeadSource();
        }
        await pollWork;
        await headWork;
    };

    async function bootstrapRealtimeScheduling(): Promise<void> {
        // Realtime bootstrap covers the recent reorg window; gap repair has its
        // own bounded, collection-scoped sweep after this head is established.
        // This blocking step ensures the first scheduled range is based on a known head.
        await apm.withSpan(
            "scheduler-worker.bootstrap.realtime",
            {
                chainId: config.chainId,
                reorgDepth,
            },
            async () => {
                const head = await rpc.getBlockNumber();
                const start = getRealtimeWindowStart(head, reorgDepth);
                await scheduleRealtimeRange(queue, config.chainId, start, head);
                lastScheduled = head;
            },
        );
    }

    async function bootstrapBlockChecks(): Promise<void> {
        // Separate bootstrap for reorg checks to keep scheduling intent explicit.
        await apm.withSpan(
            "scheduler-worker.bootstrap.blockChecks",
            {
                chainId: config.chainId,
                reorgDepth,
            },
            async () => {
                if (lastScheduled === null) return;
                const initialCheck = getReorgCheckBlock(
                    lastScheduled,
                    reorgDepth,
                );
                if (initialCheck <= 0) {
                    logger.warn(
                        "Scheduler-worker block-check bootstrap skipped",
                        {
                            component: "IndexerSchedulerWorker",
                            action: "bootstrapBlockChecks",
                            initialCheck,
                        },
                    );
                    lastChecked = initialCheck;
                    return;
                }
                await scheduleBlockCheck(queue, config.chainId, initialCheck);
                lastChecked = initialCheck;
            },
        );
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

    async function scheduleBlockChecksForHead(
        headNumber: number,
    ): Promise<void> {
        const targetCheck = getReorgCheckBlock(headNumber, reorgDepth);
        if (targetCheck < 0) return;
        const startCheck = lastChecked + 1;
        if (startCheck <= 0) {
            logger.warn("Scheduler-worker block-check range skipped", {
                component: "IndexerSchedulerWorker",
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
    queue: Pick<QueuePort, "publish">,
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

async function scheduleBlockCheck(
    queue: Pick<QueuePort, "publish">,
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
