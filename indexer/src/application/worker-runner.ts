import type { JobEnvelope } from "../domain/jobs.js";
import type { QueueName } from "../domain/queues.js";
import { JobDeferred } from "../domain/job-deferred.js";
import {
    UnsupportedJob,
    UNSUPPORTED_JOB_POLICY,
    UNSUPPORTED_JOB_LOG,
} from "../domain/unsupported-job.js";
import { logger } from "@artgod/shared/utils";
import type { QueueDeliveryOrigin } from "../ports/queue.js";
import type { QueueMessage, QueuePort } from "../ports/queue.js";
import {
    DEAD_LETTER_KIND,
    type DeadLetterPayload,
} from "../domain/dead-letter.js";
import { NOOP_APM, type ApmPort } from "@artgod/shared/observability/apm";

export type WorkerOptions = {
    queue: QueueName;
    consumerName: string;
    maxInFlight?: number;
    ackWaitMs?: number;
    extendLeaseMs?: number;
    maxAttempts?: number;
    deadLetterQueue?: QueueName;
    retryDelayMs?: number;
};

export type WorkerRuntimeHooks = {
    apm?: ApmPort;
    spanName?: string;
};

export async function runWorker<TPayload>(
    queue: QueuePort,
    options: WorkerOptions,
    handler: (
        job: JobEnvelope<TPayload>,
        origin?: QueueDeliveryOrigin,
    ) => Promise<void>,
    runtimeHooks?: WorkerRuntimeHooks,
): Promise<() => Promise<void>> {
    return queue.subscribe<TPayload>(
        options.queue,
        async (message: QueueMessage<TPayload>) => {
            const apm = runtimeHooks?.apm ?? NOOP_APM;
            const spanName = runtimeHooks?.spanName ?? "queue.consume";
            await apm.withSpan(
                spanName,
                {
                    queue: options.queue,
                    consumer: options.consumerName,
                    jobId: message.data.jobId,
                    jobKind: message.data.kind,
                    chainId: message.data.chainId,
                    attempt: message.data.attempt ?? 0,
                },
                async () => {
                    const now = Date.now();
                    if (message.data.scheduledAt > now) {
                        await message.nack({
                            delayMs: message.data.scheduledAt - now,
                        });
                        return;
                    }

                    let leaseTimer: ReturnType<typeof setInterval> | undefined;
                    if (options.extendLeaseMs) {
                        leaseTimer = setInterval(() => {
                            message.touch().catch(() => {});
                        }, options.extendLeaseMs);
                    }

                    try {
                        await handler(message.data, message.origin);
                        await message.ack();
                    } catch (err) {
                        if (err instanceof UnsupportedJob) {
                            logger.error(UNSUPPORTED_JOB_LOG, {
                                queue: options.queue,
                                consumer: options.consumerName,
                                jobId: message.data.jobId,
                                reason: err.message,
                            });
                            await message.nack({
                                delayMs: UNSUPPORTED_JOB_POLICY.retryMs,
                            });
                            return;
                        }
                        if (err instanceof JobDeferred) {
                            await message.nack({ delayMs: err.delayMs });
                            return;
                        }
                        const maxAttempts = options.maxAttempts;
                        const deadLetterQueue = options.deadLetterQueue;
                        const attempt = message.data.attempt ?? 1;

                        if (
                            maxAttempts !== undefined &&
                            deadLetterQueue &&
                            attempt >= maxAttempts
                        ) {
                            const payload: DeadLetterPayload = {
                                original: message.data as JobEnvelope<unknown>,
                                error: String(err),
                                failedAt: Date.now(),
                            };
                            const dlqJob: JobEnvelope<DeadLetterPayload> = {
                                jobId: `dlq:${message.data.jobId}:${Date.now()}`,
                                kind: DEAD_LETTER_KIND,
                                queue: deadLetterQueue,
                                payload,
                                attempt: 0,
                                scheduledAt: Date.now(),
                                chainId: message.data.chainId,
                            };
                            await queue.publish(deadLetterQueue, dlqJob);
                            await message.ack();
                            return;
                        }

                        if (options.retryDelayMs !== undefined)
                            logger.warn("Queue work failed; retry retained", {
                                queue: options.queue,
                                jobId: message.data.jobId,
                                attempt,
                                reason: String(err),
                            });
                        await message.nack({
                            reason: String(err),
                            ...(options.retryDelayMs !== undefined
                                ? { delayMs: options.retryDelayMs }
                                : {}),
                        });
                    } finally {
                        if (leaseTimer) clearInterval(leaseTimer);
                    }
                },
            );
        },
        {
            consumerName: options.consumerName,
            maxInFlight: options.maxInFlight,
            ackWaitMs: options.ackWaitMs,
        },
    );
}
