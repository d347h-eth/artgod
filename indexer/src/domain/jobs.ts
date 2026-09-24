import type { QueueName } from "./queues.js";

/** Opaque stream incarnation plus delivery position, without SDK/driver types. */
export type QueueDeliveryOrigin = {
    streamId: string;
    consumerName: string;
    sequence: number;
};
export type QueueReplayBoundary = {
    streamId: string;
    consumerName: string;
    ackFloor: number;
};

export type JobEnvelope<TPayload = unknown> = {
    jobId: string;
    kind: string;
    queue: QueueName;
    payload: TPayload;
    attempt: number;
    scheduledAt: number;
    traceId?: string;
    collectionId?: number;
    chainId: number;
};
