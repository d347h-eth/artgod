import { JSONCodec, connect } from "nats";
import {
    TOKEN_IMAGE_CACHE_JOB_KIND,
    TOKEN_IMAGE_CACHE_QUEUE_NAME,
    buildTokenImageCacheRefreshCollectionJobId,
    type TokenImageCacheRefreshCollectionPayload,
} from "@artgod/shared/media/token-image-cache-jobs";
import type { ImageCacheMode } from "@artgod/shared/media/token-image-cache";
import { resolveNatsJobSubjectPrefix } from "@artgod/shared/queue/nats-job-stream";
import { ensureNatsJobStream } from "../queue/nats-job-stream.js";

type JobEnvelope<TPayload> = {
    jobId: string;
    kind: string;
    queue: string;
    payload: TPayload;
    attempt: number;
    scheduledAt: number;
    chainId: number;
    collectionId?: number;
    traceId?: string;
};

export class NatsTokenImageCacheCommandQueue {
    private readonly subjectPrefix: string;

    constructor(
        private readonly natsUrl: string,
        private readonly streamPrefix: string,
    ) {
        this.subjectPrefix = resolveNatsJobSubjectPrefix(streamPrefix);
    }

    async publishCollectionImageCacheRefresh(input: {
        chainId: number;
        collectionId: number;
        requestedMaxDimension: number | null;
        imageCacheMode: ImageCacheMode;
        reason: TokenImageCacheRefreshCollectionPayload["reason"];
    }): Promise<void> {
        await this.publishJob(
            {
                chainId: input.chainId,
                collectionId: input.collectionId,
                cursorTokenId: null,
                requestedMaxDimension: input.requestedMaxDimension,
                imageCacheMode: input.imageCacheMode,
                reason: input.reason,
            },
            buildTokenImageCacheRefreshCollectionJobId(input),
        );
    }

    private async publishJob(
        payload: TokenImageCacheRefreshCollectionPayload,
        jobId: string,
    ): Promise<void> {
        const connection = await connect({ servers: this.natsUrl });
        try {
            const js = connection.jetstream();
            const jsm = await connection.jetstreamManager();
            await ensureNatsJobStream(jsm, this.streamPrefix);
            const subject = `${this.subjectPrefix}.${TOKEN_IMAGE_CACHE_QUEUE_NAME}`;
            const codec =
                JSONCodec<JobEnvelope<TokenImageCacheRefreshCollectionPayload>>();
            const envelope: JobEnvelope<TokenImageCacheRefreshCollectionPayload> =
                {
                    jobId,
                    kind: TOKEN_IMAGE_CACHE_JOB_KIND.RefreshCollection,
                    queue: TOKEN_IMAGE_CACHE_QUEUE_NAME,
                    payload,
                    attempt: 0,
                    scheduledAt: Date.now(),
                    chainId: payload.chainId,
                    collectionId: payload.collectionId,
                };
            await js.publish(subject, codec.encode(envelope), { msgID: jobId });
        } finally {
            await connection.drain().catch(() => undefined);
        }
    }
}
