import {
    JSONCodec,
    RetentionPolicy,
    StorageType,
    connect,
    type JetStreamManager,
} from "nats";
import {
    OPENSEA_JOB_ID_SCOPE,
    OPENSEA_JOB_KIND,
    OPENSEA_QUEUE_NAME,
    type OpenSeaBootstrapCollectionPayload,
} from "@artgod/shared/offchain/opensea-jobs";

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

export class NatsOpenSeaCommandQueue {
    private readonly streamName: string;
    private readonly subjectPrefix: string;

    constructor(
        private readonly natsUrl: string,
        private readonly streamPrefix: string,
    ) {
        this.streamName = `${streamPrefix}-jobs`;
        this.subjectPrefix = `${streamPrefix}.jobs`;
    }

    async publishOpenSeaBootstrap(input: {
        chainId: number;
        collectionId: number;
    }): Promise<void> {
        const payload: OpenSeaBootstrapCollectionPayload = {
            chainId: input.chainId,
            collectionId: input.collectionId,
            bootstrap: null,
        };
        await this.publishJob(
            OPENSEA_QUEUE_NAME.Bootstrap,
            payload,
            OPENSEA_JOB_KIND.BootstrapCollection,
            [
                OPENSEA_JOB_ID_SCOPE.BootstrapCollection,
                input.chainId,
                input.collectionId,
                Date.now(),
            ].join(":"),
            input.chainId,
            input.collectionId,
        );
    }

    private async publishJob<TPayload>(
        queueName: string,
        payload: TPayload,
        kind: string,
        jobId: string,
        chainId: number,
        collectionId: number,
    ): Promise<void> {
        const connection = await connect({ servers: this.natsUrl });
        try {
            const js = connection.jetstream();
            const jsm = await connection.jetstreamManager();
            await ensureStream(jsm, this.streamName, this.subjectPrefix);
            const subject = `${this.subjectPrefix}.${queueName}`;
            const codec = JSONCodec<JobEnvelope<TPayload>>();
            const envelope: JobEnvelope<TPayload> = {
                jobId,
                kind,
                queue: queueName,
                payload,
                attempt: 0,
                scheduledAt: Date.now(),
                chainId,
                collectionId,
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
