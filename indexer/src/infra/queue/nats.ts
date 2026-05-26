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
} from "nats";
import type { QueueName } from "../../domain/queues.js";
import type { JobEnvelope } from "../../domain/jobs.js";
import type {
    QueueMessage,
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

// Resolve the durable jobs stream name shared by queue publishers and tooling.
export function resolveNatsJobStreamName(streamPrefix: string): string {
    return `${streamPrefix}-jobs`;
}

// Resolve the subject used for one logical queue inside the shared jobs stream.
export function resolveNatsJobSubject(
    streamPrefix: string,
    queue: QueueName,
): string {
    return `${streamPrefix}.jobs.${queue}`;
}

// Resolve the wildcard subject used by the shared jobs stream.
export function resolveNatsJobsSubjectFilter(streamPrefix: string): string {
    return `${streamPrefix}.jobs.>`;
}

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
    ): Promise<void> {
        await this.ensureStream();
        const subject = this.subjectForQueue(queue);
        const codec = JSONCodec<JobEnvelope<TPayload>>();
        await this.js.publish(subject, codec.encode(message), {
            msgID: message.jobId,
        });
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
                        const deliveryCount =
                            (msg as any)?.info?.redeliveryCount ?? 0;
                        data.attempt = Math.max(
                            data.attempt ?? 0,
                            deliveryCount + 1,
                        );
                    } catch {
                        msg.term();
                        return;
                    }

                    const wrapped: QueueMessage<TPayload> = {
                        data,
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

    private async ensureStream(): Promise<void> {
        if (!this.streamReady) {
            this.streamReady = this.ensureStreamInner();
        }
        return this.streamReady;
    }

    private async ensureStreamInner(): Promise<void> {
        try {
            await this.jsm.streams.info(this.streamName);
            return;
        } catch {}

        await this.jsm.streams.add({
            name: this.streamName,
            subjects: [resolveNatsJobsSubjectFilter(this.config.streamPrefix)],
            retention: RetentionPolicy.Workqueue,
            storage: StorageType.File,
            max_age: 7 * 24 * 60 * 60 * 1_000_000_000,
        });
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
