import { randomUUID } from "node:crypto";
import {
    RetentionPolicy,
    StorageType,
    connect,
    type ConsumerInfo,
    type JetStreamClient,
    type JetStreamManager,
    type NatsConnection,
    type StreamInfo,
} from "nats";
import {
    resolveNatsJobStreamMaintenanceProbeSubject,
    resolveNatsJobStreamName,
    resolveNatsJobStreamSubjectFilter,
} from "@artgod/shared/queue/nats-job-stream";
import type {
    NatsJobStreamSnapshot,
    NatsJobStreamWriteProbe,
} from "../../application/queue/maintain-nats-job-stream.js";

// Allows a large existing stream enough time to apply a lower MaxAge policy.
const NATS_JOB_STREAM_ADMIN_REQUEST_TIMEOUT_MS = 30 * 60 * 1_000;
const NATS_JOB_STREAM_WRITE_PROBE_TIMEOUT_MS = 5_000;
const NATS_RESOURCE_LIMIT_STATUS_CODE = "503";
const NATS_REQUEST_TIMEOUT_CODE = "TIMEOUT";
const NATS_JOB_STREAM_MAINTENANCE_PROBE_MESSAGE_ID_SCOPE =
    "artgod-job-stream-maintenance-probe";

// Implements startup stream inspection and recovery through the JetStream API.
export class NatsJobStreamMaintenanceAdapter {
    private readonly streamName: string;
    private readonly probeSubject: string;

    private constructor(
        private readonly connection: NatsConnection,
        private readonly jetStream: JetStreamClient,
        private readonly manager: JetStreamManager,
        private readonly streamPrefix: string,
    ) {
        this.streamName = resolveNatsJobStreamName(streamPrefix);
        this.probeSubject =
            resolveNatsJobStreamMaintenanceProbeSubject(streamPrefix);
    }

    // Opens one isolated connection for the complete startup maintenance pass.
    static async connect(input: {
        natsUrl: string;
        streamPrefix: string;
    }): Promise<NatsJobStreamMaintenanceAdapter> {
        const connection = await connect({ servers: input.natsUrl });
        const jetStream = connection.jetstream({
            timeout: NATS_JOB_STREAM_ADMIN_REQUEST_TIMEOUT_MS,
        });
        const manager = await connection.jetstreamManager({
            timeout: NATS_JOB_STREAM_ADMIN_REQUEST_TIMEOUT_MS,
        });
        return new NatsJobStreamMaintenanceAdapter(
            connection,
            jetStream,
            manager,
            input.streamPrefix,
        );
    }

    async inspect(): Promise<NatsJobStreamSnapshot> {
        const accountInfo = await this.manager.getAccountInfo();
        const streamInfo = await this.loadStreamInfo();
        if (!streamInfo) {
            return {
                stream: null,
                account: {
                    storageBytes: accountInfo.storage,
                    maxStorageBytes: accountInfo.limits.max_storage,
                },
                consumers: [],
            };
        }

        const consumers = await this.loadConsumerSnapshots();
        return {
            stream: mapStreamSnapshot(streamInfo),
            account: {
                storageBytes: accountInfo.storage,
                maxStorageBytes: accountInfo.limits.max_storage,
            },
            consumers,
        };
    }

    async reconcileMaxAge(maxAgeNanos: number): Promise<void> {
        const streamInfo = await this.loadStreamInfo();
        if (!streamInfo) {
            await this.manager.streams.add({
                name: this.streamName,
                subjects: [
                    resolveNatsJobStreamSubjectFilter(this.streamPrefix),
                ],
                retention: RetentionPolicy.Workqueue,
                storage: StorageType.File,
                max_age: maxAgeNanos,
            });
            return;
        }
        if (streamInfo.config.max_age === maxAgeNanos) return;

        try {
            // Updating the installed stream triggers NATS MaxAge enforcement in place.
            await this.manager.streams.update(this.streamName, {
                max_age: maxAgeNanos,
            });
        } catch (error) {
            if (readErrorCode(error) !== NATS_REQUEST_TIMEOUT_CODE) throw error;

            // A large filestore can finish the update while its client response times out.
            const reconciled = await this.loadStreamInfo();
            if (reconciled?.config.max_age !== maxAgeNanos) throw error;
        }
    }

    async purge(): Promise<number> {
        const response = await this.manager.streams.purge(this.streamName);
        return response.purged;
    }

    async probeWritable(): Promise<NatsJobStreamWriteProbe> {
        const messageId = `${NATS_JOB_STREAM_MAINTENANCE_PROBE_MESSAGE_ID_SCOPE}:${randomUUID()}`;
        try {
            // Publish and immediately delete one isolated message to prove write health.
            const acknowledgement = await this.jetStream.publish(
                this.probeSubject,
                new Uint8Array(),
                {
                    msgID: messageId,
                    expect: { streamName: this.streamName },
                    timeout: NATS_JOB_STREAM_WRITE_PROBE_TIMEOUT_MS,
                },
            );
            const deleted = await this.manager.streams.deleteMessage(
                this.streamName,
                acknowledgement.seq,
                false,
            );
            if (!deleted) {
                return {
                    writable: false,
                    resourceLimited: false,
                    error: `JetStream did not delete maintenance probe sequence ${acknowledgement.seq}`,
                };
            }
            return { writable: true, resourceLimited: false, error: null };
        } catch (error) {
            const resourceLimitStatus =
                String(readErrorCode(error)) ===
                NATS_RESOURCE_LIMIT_STATUS_CODE;
            return {
                writable: false,
                // Server-global file limits return 503 but are not exposed as account max_storage.
                resourceLimited: resourceLimitStatus,
                error: formatError(error),
            };
        }
    }

    async close(): Promise<void> {
        await this.connection.drain();
    }

    private async loadStreamInfo(): Promise<StreamInfo | null> {
        try {
            return await this.manager.streams.info(this.streamName);
        } catch (error) {
            if (isStreamNotFound(error)) return null;
            throw error;
        }
    }

    private async loadConsumerSnapshots() {
        const consumers = [];
        for await (const consumer of this.manager.consumers.list(
            this.streamName,
        )) {
            consumers.push(mapConsumerSnapshot(consumer));
        }
        return consumers;
    }
}

function mapStreamSnapshot(streamInfo: StreamInfo) {
    return {
        name: streamInfo.config.name,
        maxAgeNanos: streamInfo.config.max_age,
        messages: streamInfo.state.messages,
        bytes: streamInfo.state.bytes,
        firstSequence: streamInfo.state.first_seq,
        firstTimestamp: streamInfo.state.first_ts,
        lastSequence: streamInfo.state.last_seq,
        lastTimestamp: streamInfo.state.last_ts,
        consumerCount: streamInfo.state.consumer_count,
    };
}

function mapConsumerSnapshot(consumer: ConsumerInfo) {
    const filterSubjects = consumer.config.filter_subjects;
    return {
        name: consumer.name,
        filterSubject:
            consumer.config.filter_subject ?? filterSubjects?.join(",") ?? null,
        deliveredStreamSequence: consumer.delivered.stream_seq,
        ackFloorStreamSequence: consumer.ack_floor.stream_seq,
        pending: consumer.num_pending,
        ackPending: consumer.num_ack_pending,
        redelivered: consumer.num_redelivered,
    };
}

function isStreamNotFound(error: unknown): boolean {
    const code = readErrorCode(error);
    const apiCode = (
        error as { api_error?: { code?: number } } | null | undefined
    )?.api_error?.code;
    return code === "404" || code === 404 || apiCode === 404;
}

function readErrorCode(error: unknown): string | number | undefined {
    return (error as { code?: string | number } | null | undefined)?.code;
}

function formatError(error: unknown): string {
    if (error instanceof Error) {
        const cause = error.cause instanceof Error ? error.cause.message : null;
        return cause ? `${error.message}: ${cause}` : error.message;
    }
    return String(error);
}
