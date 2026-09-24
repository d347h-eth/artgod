import {
    connect,
    consumerOpts,
    createInbox,
    JSONCodec,
    nanos,
    RetentionPolicy,
    StorageType,
    type ConsumerInfo,
    type ConsumerUpdateConfig,
    type JetStreamClient,
    type JetStreamManager,
    type NatsConnection,
    type StreamInfo,
} from "nats";
import {
    NATS_JOB_STREAM_MAX_AGE_NANOS,
    resolveNatsJobStreamName,
    resolveNatsJobStreamSubjectFilter,
    resolveNatsJobSubject,
} from "@artgod/shared/queue/nats-job-stream";
import type { QueueName } from "../../domain/queues.js";
import type { JobEnvelope, QueuePublication } from "../../domain/jobs.js";
import { logger } from "@artgod/shared/utils";
import {
    UNSUPPORTED_JOB_POLICY,
    UNSUPPORTED_JOB_LOG,
} from "../../domain/unsupported-job.js";
import type {
    QueueMessage,
    QueueReplayBoundary,
    QueuePort,
    SubscribeOptions,
} from "../../ports/queue.js";

export type NatsQueueConfig = {
    natsUrl: string;
    streamPrefix: string;
};

type DesiredConsumerConfig = {
    maxAckPending?: number;
    ackWaitMs?: number;
};

type ConsumerConfigSnapshot = Pick<
    ConsumerInfo["config"],
    "max_ack_pending" | "ack_wait"
>;

// Computes mutable durable consumer settings that drifted from runtime config.
export function resolveNatsConsumerConfigUpdate(
    existing: ConsumerConfigSnapshot,
    desired: DesiredConsumerConfig,
): Partial<ConsumerUpdateConfig> {
    const update: Partial<ConsumerUpdateConfig> = {};
    if (
        desired.maxAckPending !== undefined &&
        existing.max_ack_pending !== desired.maxAckPending
    ) {
        update.max_ack_pending = desired.maxAckPending;
    }
    if (desired.ackWaitMs !== undefined) {
        const ackWaitNanos = nanos(desired.ackWaitMs);
        if (existing.ack_wait !== ackWaitNanos) {
            update.ack_wait = ackWaitNanos;
        }
    }
    return update;
}

export class NatsJetStreamQueue implements QueuePort {
    private readonly streamName: string;
    private streamReady?: Promise<void>;
    private streamId = "";

    private constructor(
        private readonly nc: NatsConnection,
        private readonly js: JetStreamClient,
        private readonly jsm: JetStreamManager,
        private readonly config: NatsQueueConfig,
    ) {
        this.streamName = resolveNatsJobStreamName(config.streamPrefix);
    }

    static async connect(config: NatsQueueConfig): Promise<NatsJetStreamQueue> {
        const nc = await connect({ servers: config.natsUrl });
        const js = nc.jetstream();
        const jsm = await nc.jetstreamManager();
        const queue = new NatsJetStreamQueue(nc, js, jsm, config);
        await queue.ensureStream();
        return queue;
    }

    async publish<TPayload>(
        queue: QueueName,
        message: JobEnvelope<TPayload>,
    ): Promise<QueuePublication> {
        await this.ensureStream();
        const subject = this.subjectForQueue(queue);
        const codec = JSONCodec<JobEnvelope<TPayload>>();
        const published = await this.js.publish(
            subject,
            codec.encode(message),
            {
                msgID: message.jobId,
            },
        );
        return { streamId: this.streamId, sequence: published.seq };
    }

    async subscribe<TPayload>(
        queue: QueueName,
        handler: (message: QueueMessage<TPayload>) => Promise<void>,
        options: SubscribeOptions,
    ): Promise<() => Promise<void>> {
        await this.ensureStream();
        const subject = this.subjectForQueue(queue);
        await this.reconcileConsumerConfig(subject, options);
        const codec = JSONCodec<JobEnvelope<TPayload>>();
        const opts = consumerOpts();

        opts.durable(options.consumerName);
        opts.manualAck();
        opts.ackExplicit();
        opts.deliverTo(createInbox());
        opts.filterSubject(subject);
        opts.deliverAll();
        if (options.maxInFlight !== undefined) {
            opts.maxAckPending(options.maxInFlight);
        }
        if (options.ackWaitMs !== undefined) {
            opts.ackWait(options.ackWaitMs);
        }

        const sub = await this.js.subscribe(subject, opts);
        const tasks = new Set<Promise<void>>();
        const limiter = createLimiter(options.maxInFlight ?? 1);

        const loop = (async () => {
            for await (const msg of sub) {
                const task = limiter.run(async () => {
                    let data: JobEnvelope<TPayload>;
                    try {
                        data = codec.decode(msg.data);
                        if (
                            !data ||
                            typeof data !== "object" ||
                            typeof data.jobId !== "string" ||
                            !data.jobId ||
                            typeof data.kind !== "string" ||
                            !data.kind ||
                            data.queue !== queue ||
                            !Number.isSafeInteger(data.chainId) ||
                            data.chainId <= 0 ||
                            !Number.isSafeInteger(data.scheduledAt) ||
                            data.scheduledAt < 0
                        )
                            throw new Error("Invalid queue envelope");
                        if (
                            data.attempt != null &&
                            (!Number.isSafeInteger(data.attempt) ||
                                data.attempt < 0)
                        )
                            throw new Error("Invalid queue attempt");
                        data.attempt = Math.max(
                            data.attempt ?? 0,
                            // The SDK's legacy redeliveryCount is also one-based.
                            msg.info.deliveryCount,
                        );
                    } catch (error) {
                        logger.error(UNSUPPORTED_JOB_LOG, {
                            queue,
                            consumer: options.consumerName,
                            streamSequence: msg.info.streamSequence,
                            reason: String(error),
                        });
                        // Keep the original bytes. The log-only DLQ cannot preserve an
                        // unknown envelope, and TERM would make it unrecoverable.
                        msg.nak(UNSUPPORTED_JOB_POLICY.retryMs);
                        return;
                    }

                    const wrapped: QueueMessage<TPayload> = {
                        data,
                        origin: {
                            streamId: this.streamId,
                            consumerName: options.consumerName,
                            sequence: msg.info.streamSequence,
                        },
                        ack: async () => {
                            msg.ack();
                        },
                        nack: async (opts) => {
                            if (opts?.delayMs !== undefined) {
                                msg.nak(opts.delayMs);
                                return;
                            }
                            msg.nak();
                        },
                        touch: async () => {
                            msg.working();
                        },
                    };

                    try {
                        await handler(wrapped);
                    } catch {
                        msg.nak();
                    }
                });

                tasks.add(task);
                task.finally(() => tasks.delete(task));
            }
        })();

        return async () => {
            sub.drain();
            await loop;
            if (tasks.size > 0) {
                await Promise.allSettled(Array.from(tasks));
            }
        };
    }

    async close(): Promise<void> {
        await this.nc.drain();
    }

    /** Completed receipt cleanup is bounded by broker ACK evidence, never a guessed TTL. */
    async getReplayBoundary(
        consumerName: string,
    ): Promise<QueueReplayBoundary> {
        const stream = await this.jsm.streams.info(this.streamName);
        const streamId = `${stream.config.name}:${stream.created}`;
        if (streamId !== this.streamId)
            throw new Error("Job stream incarnation changed");
        const consumer = await this.jsm.consumers.info(
            this.streamName,
            consumerName,
        );
        return {
            streamId,
            consumerName,
            ackFloor: consumer.ack_floor.stream_seq,
        };
    }

    /** ACK evidence wins over physically retained messages on older brokers. */
    async isPublicationPending(
        publication: QueuePublication,
        consumerName: string,
    ): Promise<boolean> {
        if (publication.streamId !== this.streamId) return false;
        const boundary = await this.getReplayBoundary(consumerName);
        if (boundary.ackFloor >= publication.sequence) return false;
        try {
            await this.jsm.streams.getMessage(this.streamName, {
                seq: publication.sequence,
            });
            return true;
        } catch (error) {
            if (isStreamNotFound(error)) return false;
            throw error;
        }
    }

    private async ensureStream(): Promise<void> {
        if (!this.streamReady) {
            this.streamReady = this.ensureStreamInner();
        }
        return this.streamReady;
    }

    private async ensureStreamInner(): Promise<void> {
        let existing: StreamInfo | undefined;
        try {
            existing = await this.jsm.streams.info(this.streamName);
        } catch (error) {
            if (!isStreamNotFound(error)) throw error;
        }

        if (existing) {
            this.streamId = `${existing.config.name}:${existing.created}`;
            if (existing.config.max_age !== NATS_JOB_STREAM_MAX_AGE_NANOS) {
                await this.jsm.streams.update(this.streamName, {
                    max_age: NATS_JOB_STREAM_MAX_AGE_NANOS,
                });
            }
            return;
        }

        const created = await this.jsm.streams.add({
            name: this.streamName,
            subjects: [
                resolveNatsJobStreamSubjectFilter(this.config.streamPrefix),
            ],
            retention: RetentionPolicy.Workqueue,
            storage: StorageType.File,
            max_age: NATS_JOB_STREAM_MAX_AGE_NANOS,
        });
        this.streamId = `${created.config.name}:${created.created}`;
    }

    private subjectForQueue(queue: QueueName): string {
        return resolveNatsJobSubject(this.config.streamPrefix, queue);
    }

    private async reconcileConsumerConfig(
        subject: string,
        options: SubscribeOptions,
    ): Promise<void> {
        let info: ConsumerInfo;
        try {
            info = await this.jsm.consumers.info(
                this.streamName,
                options.consumerName,
            );
        } catch (error) {
            if (isConsumerNotFound(error)) return;
            throw error;
        }

        assertConsumerSubjectMatches(info, subject, options.consumerName);
        const update = resolveNatsConsumerConfigUpdate(info.config, {
            maxAckPending: options.maxInFlight,
            ackWaitMs: options.ackWaitMs,
        });
        if (Object.keys(update).length === 0) return;

        await this.jsm.consumers.update(
            this.streamName,
            options.consumerName,
            update,
        );
    }
}

function assertConsumerSubjectMatches(
    info: ConsumerInfo,
    subject: string,
    consumerName: string,
): void {
    const filterSubject = info.config.filter_subject;
    if (filterSubject && filterSubject !== subject) {
        throw new Error(
            `Durable consumer ${consumerName} filters ${filterSubject}, expected ${subject}`,
        );
    }

    const filterSubjects = info.config.filter_subjects;
    if (filterSubjects && !filterSubjects.includes(subject)) {
        throw new Error(
            `Durable consumer ${consumerName} does not filter ${subject}`,
        );
    }
}

function isConsumerNotFound(error: unknown): boolean {
    const code = (error as { code?: string | number } | undefined)?.code;
    return code === "404" || code === 404;
}

function isStreamNotFound(error: unknown): boolean {
    const code = (error as { code?: string | number } | undefined)?.code;
    const apiCode = (error as { api_error?: { code?: number } } | undefined)
        ?.api_error?.code;
    return code === "404" || code === 404 || apiCode === 404;
}

function createLimiter(limit: number) {
    let inFlight = 0;
    const waiters: Array<() => void> = [];

    const acquire = async () => {
        if (inFlight < limit) {
            inFlight += 1;
            return;
        }
        await new Promise<void>((resolve) => waiters.push(resolve));
        inFlight += 1;
    };

    const release = () => {
        inFlight = Math.max(0, inFlight - 1);
        const next = waiters.shift();
        if (next) next();
    };

    const run = async <T>(fn: () => Promise<T>): Promise<T> => {
        await acquire();
        try {
            return await fn();
        } finally {
            release();
        }
    };

    return { run };
}
