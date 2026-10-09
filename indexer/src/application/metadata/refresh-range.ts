import { logger } from "@artgod/shared/utils";
import {
    buildMetadataRangeContinuation,
    chunkMetadataTokenRange,
} from "../../domain/metadata-refresh-range.js";
import {
    METADATA_STATS_RECOMPUTE_REASON,
    type MetadataRefreshRangePayload,
} from "../../domain/domain-jobs.js";
import { METADATA_REFRESH_RUN_ID_SCOPE } from "../../domain/metadata-refresh-followups.js";
import type { JobEnvelope } from "../../domain/jobs.js";
import type { MetadataUpdatedToken } from "../../domain/metadata.js";
import type { MetadataDomainPort } from "../../ports/domain-handlers.js";
import type { QueuePort } from "../../ports/queue.js";
import type { CollectionExtensionInstallPort } from "../../ports/collection-extensions.js";
import {
    enqueueMetadataRefreshFollowups,
    type MetadataRefreshFollowupStoragePort,
} from "./refresh-followups.js";
import {
    publishMetadataImageRefreshes,
    type MetadataImageCachePolicyPort,
} from "./image-refresh.js";

// Processes one bounded chunk. The full domain envelope retains the fixed root
// identity and origin across queue continuations.
export function createMetadataRefreshRangeHandler(input: {
    queue: Pick<QueuePort, "publish">;
    metadata: Pick<MetadataDomainPort, "handleMetadataRefresh">;
    followups: MetadataRefreshFollowupStoragePort;
    extensions: Pick<CollectionExtensionInstallPort, "getInstall">;
    imagePolicy: MetadataImageCachePolicyPort;
    chunkSize: number;
}): (job: JobEnvelope<MetadataRefreshRangePayload>) => Promise<void> {
    return async (job) => {
        const { payload } = job;
        if (
            job.chainId !== payload.chainId ||
            (job.collectionId !== undefined &&
                job.collectionId !== payload.collectionId)
        )
            throw new Error(
                "Metadata range envelope and payload scopes differ",
            );
        const { tokenIds, nextCursorTokenId } = chunkMetadataTokenRange({
            fromTokenId: payload.fromTokenId,
            toTokenId: payload.toTokenId,
            cursorTokenId: payload.cursorTokenId,
            chunkSize: input.chunkSize,
        });
        const traceId = job.traceId ?? job.jobId;
        const updatedTokens: MetadataUpdatedToken[] = [];
        for (const tokenId of tokenIds) {
            const updated = await input.metadata.handleMetadataRefresh({
                chainId: payload.chainId,
                collectionId: payload.collectionId,
                tokenId,
                metadataUrl: null,
                reason: payload.reason,
                source: payload.source,
            });
            if (updated) updatedTokens.push(updated);
        }
        if (updatedTokens.length) {
            enqueueMetadataRefreshFollowups({
                followups: input.followups,
                collectionExtensions: input.extensions,
                chainId: payload.chainId,
                updatedTokens,
                runScope: METADATA_REFRESH_RUN_ID_SCOPE.MetadataRefreshRange,
                artifactReason: payload.reason,
                statsReason: METADATA_STATS_RECOMPUTE_REASON.MetadataRefresh,
                sourceJobId: job.jobId,
                workClass: job.workClass,
                traceId,
                source: payload.source,
            });
            await publishMetadataImageRefreshes({
                queue: input.queue,
                policy: input.imagePolicy,
                chainId: payload.chainId,
                updatedTokens,
                workClass: job.workClass,
                traceId,
                source: payload.source,
            });
        }
        logger.debug("Metadata refresh range chunk processed", {
            component: "MetadataRefreshRange",
            action: "chunk",
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            fromTokenId: payload.fromTokenId,
            toTokenId: payload.toTokenId,
            cursorTokenId: payload.cursorTokenId,
            processed: tokenIds.length,
            nextCursorTokenId,
        });
        if (nextCursorTokenId === null) return;
        const next = buildMetadataRangeContinuation({
            job,
            cursorTokenId: nextCursorTokenId,
            now: Date.now(),
        });
        await input.queue.publish(next.queue, next);
    };
}
