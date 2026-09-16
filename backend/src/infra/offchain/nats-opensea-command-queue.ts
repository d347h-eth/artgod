import { JSONCodec, connect } from "nats";
import {
    OPENSEA_JOB_ID_SCOPE,
    OPENSEA_JOB_KIND,
    OPENSEA_QUEUE_NAME,
    type OpenSeaBootstrapCollectionPayload,
} from "@artgod/shared/offchain/opensea-jobs";
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

export class NatsOpenSeaCommandQueue {
    private readonly subjectPrefix: string;

    constructor(
        private readonly natsUrl: string,
        private readonly streamPrefix: string,
    ) {
        this.subjectPrefix = resolveNatsJobSubjectPrefix(streamPrefix);
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
            await ensureNatsJobStream(jsm, this.streamPrefix);
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
