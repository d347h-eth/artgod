import { logger } from "@artgod/shared/utils";
import type { JobEnvelope } from "../../domain/jobs.js";
import type { QueueName } from "../../domain/queues.js";
import type { QueuePort } from "../../ports/queue.js";

export type QueueOutboxDrainRecord = {
    outboxId: number;
    queueName: QueueName;
    jobJson: string;
    attempts: number;
};

// QueueOutboxDrainPort is the application boundary for persisted publications.
export interface QueueOutboxDrainPort {
    listDue(nowMs: number, limit: number): QueueOutboxDrainRecord[];
    markSent(outboxId: number): void;
    markFailed(input: {
        outboxId: number;
        attempts: number;
        nextAttemptAt: number;
        lastError: string;
        terminal: boolean;
    }): void;
}

// QueueOutboxDrainerOptions tunes polling and bounded publish retries.
export type QueueOutboxDrainerOptions = {
    pollMs?: number;
    limit?: number;
    maxAttempts?: number;
    retryBaseDelayMs?: number;
    retryMaxDelayMs?: number;
};

// Queue outbox defaults bound broker retries without losing persisted jobs.
export const QUEUE_OUTBOX_DRAINER_DEFAULTS = {
    PollMs: 1_000,
    Limit: 100,
    MaxAttempts: 5,
    RetryBaseDelayMs: 1_000,
    RetryMaxDelayMs: 60_000,
    StopWaitMs: 10,
} as const;

const QUEUE_OUTBOX_DRAINER_LOG_COMPONENT = "QueueOutboxDrainer";
const QUEUE_OUTBOX_DRAINER_LOG_ACTION = {
    Drain: "drain",
    Start: "start",
    Stop: "stop",
} as const;

// Starts the background queue-outbox publisher owned by the domain worker.
export function startQueueOutboxDrainer(
    outbox: QueueOutboxDrainPort,
    queue: QueuePort,
    options: QueueOutboxDrainerOptions = {},
): () => Promise<void> {
    const pollMs = options.pollMs ?? QUEUE_OUTBOX_DRAINER_DEFAULTS.PollMs;
    let running = false;
    let stopped = false;

    const tick = async () => {
        if (running || stopped) {
            return;
        }
        running = true;
        try {
            await drainQueueOutbox(outbox, queue, options);
        } catch (error) {
            logger.warn("Queue outbox drain failed", {
                component: QUEUE_OUTBOX_DRAINER_LOG_COMPONENT,
                action: QUEUE_OUTBOX_DRAINER_LOG_ACTION.Drain,
                error: String(error),
            });
        } finally {
            running = false;
        }
    };

    const interval = setInterval(() => {
        void tick();
    }, pollMs);
    void tick();
    logger.info("Queue outbox drainer started", {
        component: QUEUE_OUTBOX_DRAINER_LOG_COMPONENT,
        action: QUEUE_OUTBOX_DRAINER_LOG_ACTION.Start,
        pollMs,
    });

    return async () => {
        stopped = true;
        clearInterval(interval);
        while (running) {
            await sleep(QUEUE_OUTBOX_DRAINER_DEFAULTS.StopWaitMs);
        }
        logger.info("Queue outbox drainer stopped", {
            component: QUEUE_OUTBOX_DRAINER_LOG_COMPONENT,
            action: QUEUE_OUTBOX_DRAINER_LOG_ACTION.Stop,
        });
    };
}

// Publishes every due outbox row and advances durable delivery state.
export async function drainQueueOutbox(
    outbox: QueueOutboxDrainPort,
    queue: QueuePort,
    options: QueueOutboxDrainerOptions = {},
): Promise<number> {
    const limit = options.limit ?? QUEUE_OUTBOX_DRAINER_DEFAULTS.Limit;
    const due = outbox.listDue(Date.now(), limit);
    let published = 0;
    for (const row of due) {
        const attempts = row.attempts + 1;
        try {
            const job = JSON.parse(row.jobJson) as JobEnvelope<unknown>;
            await queue.publish(row.queueName, job);
            outbox.markSent(row.outboxId);
            published += 1;
        } catch (error) {
            const terminal =
                attempts >=
                (options.maxAttempts ??
                    QUEUE_OUTBOX_DRAINER_DEFAULTS.MaxAttempts);
            outbox.markFailed({
                outboxId: row.outboxId,
                attempts,
                nextAttemptAt: terminal
                    ? 0
                    : Date.now() + resolveRetryDelayMs(attempts, options),
                lastError: String(error),
                terminal,
            });
        }
    }
    return published;
}

function resolveRetryDelayMs(
    attempts: number,
    options: QueueOutboxDrainerOptions,
): number {
    const base =
        options.retryBaseDelayMs ??
        QUEUE_OUTBOX_DRAINER_DEFAULTS.RetryBaseDelayMs;
    const max =
        options.retryMaxDelayMs ??
        QUEUE_OUTBOX_DRAINER_DEFAULTS.RetryMaxDelayMs;
    return Math.min(max, base * 2 ** Math.max(0, attempts - 1));
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
