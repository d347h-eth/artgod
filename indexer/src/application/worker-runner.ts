import type { JobEnvelope } from "../domain/jobs.js";
import type { QueueName } from "../domain/queues.js";
import type { QueuePort } from "../ports/queue.js";

export type WorkerOptions = {
    queue: QueueName;
    consumerName: string;
    maxInFlight?: number;
    ackWaitMs?: number;
    extendLeaseMs?: number;
};

export async function runWorker<TPayload>(
    queue: QueuePort,
    options: WorkerOptions,
    handler: (job: JobEnvelope<TPayload>) => Promise<void>,
): Promise<() => Promise<void>> {
    return queue.subscribe(
        options.queue,
        async (message) => {
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
