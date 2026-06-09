import {
    JSONCodec,
    RetentionPolicy,
    StorageType,
    connect,
    type JetStreamManager,
} from "nats";
import {
    TOKEN_IMAGE_CACHE_JOB_KIND,
    TOKEN_IMAGE_CACHE_QUEUE_NAME,
    buildTokenImageCacheRefreshCollectionJobId,
    type TokenImageCacheRefreshCollectionPayload,
} from "@artgod/shared/media/token-image-cache-jobs";
import type { ImageCacheMode } from "@artgod/shared/media/token-image-cache";

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
    private readonly streamName: string;
    private readonly subjectPrefix: string;

    constructor(
        private readonly natsUrl: string,
        private readonly streamPrefix: string,
    ) {
        this.streamName = `${streamPrefix}-jobs`;
        this.subjectPrefix = `${streamPrefix}.jobs`;
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
            await ensureStream(jsm, this.streamName, this.subjectPrefix);
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

async function ensureStream(
    jsm: JetStreamManager,
    streamName: string,
    subjectPrefix: string,
): Promise<void> {
    try {
        await jsm.streams.info(streamName);
        return;
    } catch {}
    await jsm.streams.add({
        name: streamName,
        subjects: [`${subjectPrefix}.>`],
        retention: RetentionPolicy.Workqueue,
        storage: StorageType.File,
        max_age: 7 * 24 * 60 * 60 * 1_000_000_000,
    });
}
