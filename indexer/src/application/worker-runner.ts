import type { JobEnvelope } from "../domain/jobs.js";
import type { QueueName } from "../domain/queues.js";
import type { QueueMessage, QueuePort } from "../ports/queue.js";
import { DEAD_LETTER_KIND, type DeadLetterPayload } from "../domain/dead-letter.js";

export type WorkerOptions = {
    queue: QueueName;
    consumerName: string;
    maxInFlight?: number;
    ackWaitMs?: number;
    extendLeaseMs?: number;
    maxAttempts?: number;
    deadLetterQueue?: QueueName;
};

export async function runWorker<TPayload>(
    queue: QueuePort,
    options: WorkerOptions,
    handler: (job: JobEnvelope<TPayload>) => Promise<void>,
): Promise<() => Promise<void>> {
    return queue.subscribe<TPayload>(
        options.queue,
        async (message: QueueMessage<TPayload>) => {
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
                await handler(message.data);
                await message.ack();
            } catch (err) {
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

                await message.nack({ reason: String(err) });
            } finally {
                if (leaseTimer) clearInterval(leaseTimer);
            }
        },
        {
            consumerName: options.consumerName,
            maxInFlight: options.maxInFlight,
            ackWaitMs: options.ackWaitMs,
        },
    );
}
