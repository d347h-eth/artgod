import type { QueueName } from "../domain/queues.js";
import type {
    JobEnvelope,
    QueueDeliveryOrigin,
    QueuePublication,
} from "../domain/jobs.js";
export type {
    QueueDeliveryOrigin,
    QueueReplayBoundary,
} from "../domain/jobs.js";

export type QueueMessage<TPayload> = {
    data: JobEnvelope<TPayload>;
    origin?: QueueDeliveryOrigin;
    ack: () => Promise<void>;
    nack: (opts?: { delayMs?: number; reason?: string }) => Promise<void>;
    touch: () => Promise<void>;
};

export type SubscribeOptions = {
    consumerName: string;
    maxInFlight?: number;
    ackWaitMs?: number;
};

export interface QueuePort {
    publish<TPayload>(
        queue: QueueName,
        message: JobEnvelope<TPayload>,
    ): Promise<void | QueuePublication>;
    subscribe<TPayload>(
        queue: QueueName,
        handler: (message: QueueMessage<TPayload>) => Promise<void>,
        options: SubscribeOptions,
    ): Promise<() => Promise<void>>;
    close(): Promise<void>;
}
