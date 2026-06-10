import {
    JSONCodec,
    RetentionPolicy,
    StorageType,
    connect,
    type JetStreamClient,
    type JetStreamManager,
    type NatsConnection,
} from "nats";
import {
    BOOTSTRAP_JOB_ID_SCOPE,
    BOOTSTRAP_JOB_KIND,
    BOOTSTRAP_QUEUE_NAME,
} from "@artgod/shared/bootstrap/jobs";
import type { BootstrapCommandQueuePort } from "../../application/use-cases/bootstrap/ports.js";

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

export class NatsBootstrapCommandQueue implements BootstrapCommandQueuePort {
    private readonly streamName: string;
    private readonly subjectPrefix: string;

    constructor(
        private readonly natsUrl: string,
        private readonly streamPrefix: string,
    ) {
        this.streamName = `${streamPrefix}-jobs`;
        this.subjectPrefix = `${streamPrefix}.jobs`;
    }

    async publishBootstrapStart(input: {
        chainId: number;
        runId: number;
        collectionId: number;
    }): Promise<void> {
        await this.publishJob(
            BOOTSTRAP_QUEUE_NAME.CollectionBootstrapImageCache,
            {
                chainId: input.chainId,
                runId: input.runId,
                collectionId: input.collectionId,
            },
            BOOTSTRAP_JOB_KIND.Start,
            `${BOOTSTRAP_JOB_ID_SCOPE.Start}:${input.chainId}:${input.runId}:${Date.now()}`,
            input.chainId,
            input.collectionId,
        );
    }

    async publishBootstrapMetadataProcess(input: {
        chainId: number;
        runId: number;
        collectionId: number;
        address: string;
        standard: "erc721" | "erc1155";
        metadataMode: "strict" | "best_effort";
        anchorBlock: number;
        anchorHash: string;
        anchorTimestamp: number;
    }): Promise<void> {
        await this.publishJob(
            BOOTSTRAP_QUEUE_NAME.CollectionBootstrap,
            {
                chainId: input.chainId,
                runId: input.runId,
                collectionId: input.collectionId,
                address: input.address,
                standard: input.standard,
                metadataSnapshotMode: input.metadataMode,
                anchorBlock: input.anchorBlock,
                anchorHash: input.anchorHash,
                anchorTimestamp: input.anchorTimestamp,
            },
            BOOTSTRAP_JOB_KIND.MetadataProcess,
            `${BOOTSTRAP_JOB_ID_SCOPE.Metadata}:${input.chainId}:${input.runId}:${Date.now()}`,
            input.chainId,
            input.collectionId,
        );
    }

    async publishBootstrapImageCacheProcess(input: {
        chainId: number;
        runId: number;
        collectionId: number;
        address: string;
        standard: "erc721" | "erc1155";
        anchorBlock: number;
        anchorHash: string;
        anchorTimestamp: number;
    }): Promise<void> {
        await this.publishJob(
            BOOTSTRAP_QUEUE_NAME.CollectionBootstrap,
            {
                chainId: input.chainId,
                runId: input.runId,
                collectionId: input.collectionId,
                address: input.address,
                standard: input.standard,
                anchorBlock: input.anchorBlock,
                anchorHash: input.anchorHash,
                anchorTimestamp: input.anchorTimestamp,
            },
            BOOTSTRAP_JOB_KIND.ImageCacheProcess,
            `${BOOTSTRAP_JOB_ID_SCOPE.ImageCache}:${input.chainId}:${input.runId}:${Date.now()}`,
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
