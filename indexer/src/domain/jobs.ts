import type { QueueName } from "./queues.js";
import type { ChainBlockReference } from "./chain-sync.js";
import type { SyncWorkClass } from "@artgod/shared/types/sync-work-class";

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

/** Broker evidence for a durable publication, scoped to one stream incarnation. */
export type QueuePublication = { streamId: string; sequence: number };

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
    // Optional solely for old persisted envelopes, which decode as main work.
    workClass?: SyncWorkClass;
    // Event-specific sync hints must still refer to the retained canonical block
    // at consumer admission, including when publication races with rollback.
    onchainBlock?: ChainBlockReference;
};
