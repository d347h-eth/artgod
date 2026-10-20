import { logger } from "@artgod/shared/utils";
import type { IndexerConfig } from "../config/index.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import type { RealtimeSyncPayload } from "../domain/sync-jobs.js";
import { SYNC_JOB_KIND } from "../domain/sync-jobs.js";
import type { JobEnvelope } from "../domain/jobs.js";
import type { HeadSourcePort } from "../ports/head-source.js";
import type { QueuePort } from "../ports/queue.js";
import type { RpcProviderPort } from "../ports/rpc.js";
import type { ChainProgressPort } from "../ports/chain-progress.js";
import { NOOP_APM, type ApmPort } from "@artgod/shared/observability/apm";
import {
    ChainSyncConflict,
    realtimeWindowStart,
} from "../domain/chain-sync.js";

export type SchedulerWorkerOptions = {
    pollIntervalMs?: number;
    headSource?: HeadSourcePort;
    apm?: ApmPort;
};

// Head observations are coordinator scheduling evidence, not canonical progress.
// Retain their captured admission watermark before publishing optional wakeups.
export async function startSchedulerWorker(
    rpc: Pick<RpcProviderPort, "getBlockNumber" | "getBlock">,
    queue: Pick<QueuePort, "publish">,
    progress: Pick<ChainProgressPort, "captureHeadSample" | "recordHeadSample">,
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
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let stopHeadSource: (() => Promise<void>) | undefined;
    let headWork: Promise<void> = Promise.resolve();
    let pollWork: Promise<void> | null = null;

    await bootstrapRealtimeScheduling();

    const handleHead = (headNumber: number): Promise<void> => {
        if (stopped) return Promise.resolve();
        // WS and HTTP publications share one cursor. Serialize their updates so
        // a slower, older head cannot move that cursor backward.
        const next = headWork.then(async () => {
            if (stopped || lastScheduled === null) return;
            if (headNumber > lastScheduled)
                await scheduleRealtimeForHead(headNumber);
        });
        headWork = next.catch(() => {});
        return next;
    };

    if (options.headSource) {
        // WS notifications only wake scheduling. They cannot bind admissions to
        // a head that may have been observed before the local admission existed.
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
        // Sample even at stationary HEAD: new admissions need a later remote
        // observation, not a newly mined block or a per-order RPC read.
        const current = await sampleCurrentHead();
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
        // Bound the advisory wakeup tail. Durable target and applied progress
        // let the coordinator catch up across older ranges independently.
        // Record the first remote observation before scheduling any wakeup.
        await apm.withSpan(
            "scheduler-worker.bootstrap.realtime",
            {
                chainId: config.chainId,
                reorgDepth,
            },
            async () => {
                const head = await sampleCurrentHead();
                const start = realtimeWindowStart(head, reorgDepth);
                await scheduleRealtimeRange(queue, config.chainId, start, head);
                lastScheduled = head;
            },
        );
    }

    async function sampleCurrentHead(): Promise<number> {
        // Capturing after RPC would incorrectly include hints received during
        // that read. Retention also fences a rollback while the read is active.
        const request = progress.captureHeadSample(config.chainId);
        const number = await rpc.getBlockNumber();
        const head = await rpc.getBlock(number, { fresh: true });
        if (head.number !== number)
            throw new ChainSyncConflict("Head sample returned the wrong block");
        progress.recordHeadSample(request, head, Date.now());
        return number;
    }

    async function scheduleRealtimeForHead(headNumber: number): Promise<void> {
        // Schedule only the new head range; dedupe happens at the broker via jobId.
        if (lastScheduled === null) return;
        await scheduleRealtimeRange(
            queue,
            config.chainId,
            Math.max(
                lastScheduled + 1,
                realtimeWindowStart(headNumber, reorgDepth),
            ),
            headNumber,
        );
        lastScheduled = headNumber;
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
