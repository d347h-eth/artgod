import type { JobEnvelope } from "../../domain/jobs.js";
import type { QueuePort } from "../../ports/queue.js";
import {
    COLLECTION_EXTENSION_JOB_KIND,
    type CollectionExtensionRefreshArtifactsPayload,
} from "../../domain/collection-extension-jobs.js";
import { QUEUE_NAMES } from "../../domain/queues.js";

export function buildCollectionExtensionRefreshArtifactsJob(
    payload: CollectionExtensionRefreshArtifactsPayload,
    traceId: string,
): JobEnvelope<CollectionExtensionRefreshArtifactsPayload> {
    const contract = payload.contract.toLowerCase();
    return {
        jobId: `collection-extension:artifacts:${payload.chainId}:${payload.collectionId ?? "contract"}:${contract}:${payload.tokenId}:${payload.reason}`,
        kind: COLLECTION_EXTENSION_JOB_KIND.RefreshArtifacts,
        queue: QUEUE_NAMES.CollectionExtensionArtifacts,
        payload: {
            ...payload,
            contract,
        },
        attempt: 0,
        scheduledAt: Date.now(),
        chainId: payload.chainId,
        collectionId: payload.collectionId ?? undefined,
        traceId,
    };
}

export async function publishCollectionExtensionRefreshArtifacts(
    queue: QueuePort,
    payload: CollectionExtensionRefreshArtifactsPayload,
    traceId: string,
): Promise<void> {
    const job = buildCollectionExtensionRefreshArtifactsJob(payload, traceId);
    await queue.publish(QUEUE_NAMES.CollectionExtensionArtifacts, job);
}
