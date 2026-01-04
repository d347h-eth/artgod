import type { QueueName } from "./queues.js";

export type JobEnvelope<TPayload = unknown> = {
    jobId: string;
    kind: string;
    queue: QueueName;
    payload: TPayload;
    attempt: number;
    scheduledAt: number;
    traceId?: string;
    collectionId?: string;
    chainId: number;
};
