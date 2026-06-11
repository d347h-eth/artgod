import type { JobEnvelope } from "../../domain/jobs.js";
import type { QueuePort } from "../../ports/queue.js";
import {
    COLLECTION_EXTENSION_JOB_ID_SCOPE,
    COLLECTION_EXTENSION_JOB_KIND,
    type CollectionExtensionRefreshArtifactsPayload,
} from "../../domain/collection-extension-jobs.js";
import { QUEUE_NAMES } from "../../domain/queues.js";

export type CollectionExtensionRefreshArtifactsJobOptions = {
    attempt?: number;
    delayMs?: number;
};

export function buildCollectionExtensionRefreshArtifactsJob(
    payload: CollectionExtensionRefreshArtifactsPayload,
    traceId: string,
    options: CollectionExtensionRefreshArtifactsJobOptions = {},
): JobEnvelope<CollectionExtensionRefreshArtifactsPayload> {
    const contract = payload.contract.toLowerCase();
    const scheduledAt = Date.now() + Math.max(0, options.delayMs ?? 0);
    const attempt = options.attempt ?? 0;
    const jobId = buildCollectionExtensionRefreshArtifactsJobId(
        payload,
        attempt,
        scheduledAt,
    );
    return {
        jobId,
        kind: COLLECTION_EXTENSION_JOB_KIND.RefreshArtifacts,
        queue: QUEUE_NAMES.CollectionExtensionArtifacts,
        payload: {
            ...payload,
            contract,
        },
        attempt,
        scheduledAt,
        chainId: payload.chainId,
        collectionId: payload.collectionId,
        traceId,
    };
}

export async function publishCollectionExtensionRefreshArtifacts(
    queue: QueuePort,
    payload: CollectionExtensionRefreshArtifactsPayload,
    traceId: string,
    options?: CollectionExtensionRefreshArtifactsJobOptions,
): Promise<void> {
    const job = buildCollectionExtensionRefreshArtifactsJob(
        payload,
        traceId,
        options,
    );
    await queue.publish(QUEUE_NAMES.CollectionExtensionArtifacts, job);
}

function buildCollectionExtensionRefreshArtifactsJobId(
    payload: CollectionExtensionRefreshArtifactsPayload,
    attempt: number,
    scheduledAt: number,
): string {
    if (payload.bootstrap) {
        return [
            COLLECTION_EXTENSION_JOB_ID_SCOPE.BootstrapArtifacts,
            payload.chainId,
            payload.bootstrap.runId,
            payload.collectionId,
            payload.tokenId,
            attempt,
            scheduledAt,
        ].join(":");
    }
    return [
        COLLECTION_EXTENSION_JOB_ID_SCOPE.RefreshArtifacts,
        payload.chainId,
        payload.collectionId,
        payload.tokenId,
        payload.reason,
    ].join(":");
}
