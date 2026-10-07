import {
    shouldRefreshImageCacheOnMetadata,
    type ImageCachePolicyConfig,
} from "@artgod/shared/media/token-image-cache";
import {
    TOKEN_IMAGE_CACHE_JOB_KIND,
    TOKEN_IMAGE_CACHE_REFRESH_REASON,
    buildTokenImageCacheRefreshTokenJobId,
    type TokenImageCacheRefreshTokenPayload,
} from "@artgod/shared/media/token-image-cache-jobs";
import type { JobEnvelope } from "../../domain/jobs.js";
import type { MetadataUpdatedToken } from "../../domain/metadata.js";
import { QUEUE_NAMES } from "../../domain/queues.js";
import type { QueuePort } from "../../ports/queue.js";

export interface MetadataImageCachePolicyPort {
    getImageCachePolicyConfig(input: {
        chainId: number;
        collectionId: number;
    }): ImageCachePolicyConfig;
}

// Reused by single-token and range refreshes after their canonical metadata write.
export async function publishMetadataImageRefreshes(input: {
    queue: Pick<QueuePort, "publish">;
    policy: MetadataImageCachePolicyPort;
    chainId: number;
    updatedTokens: readonly MetadataUpdatedToken[];
    traceId: string;
    source?: string | null;
}): Promise<void> {
    const policies = new Map<number, ImageCachePolicyConfig>();
    for (const updated of input.updatedTokens) {
        const sourceImageUrl = updated.image?.trim() ?? "";
        if (!sourceImageUrl) continue;
        let policy = policies.get(updated.collectionId);
        if (!policy) {
            policy = input.policy.getImageCachePolicyConfig({
                chainId: input.chainId,
                collectionId: updated.collectionId,
            });
            policies.set(updated.collectionId, policy);
        }
        if (!shouldRefreshImageCacheOnMetadata(policy)) continue;
        const payload: TokenImageCacheRefreshTokenPayload = {
            chainId: input.chainId,
            collectionId: updated.collectionId,
            tokenId: updated.tokenId,
            sourceImageUrl,
            requestedMaxDimension: policy.maxDimension,
            imageCacheMode: policy.imageCacheMode,
            reason: TOKEN_IMAGE_CACHE_REFRESH_REASON.MetadataRefresh,
            source: input.source ?? null,
        };
        const job: JobEnvelope<TokenImageCacheRefreshTokenPayload> = {
            jobId: buildTokenImageCacheRefreshTokenJobId(payload),
            kind: TOKEN_IMAGE_CACHE_JOB_KIND.RefreshToken,
            queue: QUEUE_NAMES.TokenImageCache,
            payload,
            attempt: 0,
            scheduledAt: Date.now(),
            chainId: input.chainId,
            collectionId: updated.collectionId,
            traceId: input.traceId,
        };
        await input.queue.publish(QUEUE_NAMES.TokenImageCache, job);
    }
}
