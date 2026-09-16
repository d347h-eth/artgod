import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
    AckPolicy,
    DeliverPolicy,
    RetentionPolicy,
    StorageType,
    connect,
    type ConsumerInfo,
    type JetStreamClient,
    type JetStreamManager,
    type NatsConnection,
    type PubAck,
    type StreamInfo,
} from "nats";
import {
    resolveNatsJobStreamMaintenanceProbeSubject,
    resolveNatsJobStreamName,
    resolveNatsJobStreamSubjectFilter,
    resolveNatsJobSubjectPrefix,
} from "@artgod/shared/queue/nats-job-stream";
import {
    isExactJobSubject,
    planAcknowledgedJobStreamCleanup,
    type AcknowledgedJobStreamCleanup,
    type NatsJobStreamSnapshot,
    type NatsJobStreamWriteProbe,
} from "../../application/queue/maintain-nats-job-stream.js";

// Large scoped cleanup can take time. The supervisor owns the 15-minute total
// deadline and stops this child and NATS before admitting another attempt.
const NATS_JOB_STREAM_ADMIN_REQUEST_TIMEOUT_MS = 15 * 60 * 1_000;
const NATS_JOB_STREAM_WRITE_PROBE_TIMEOUT_MS = 5_000;
// JetStream's resource errors are distinct from the shared 503 no-responder status.
const NATS_RESOURCE_LIMIT_API_ERROR_CODE = {
    InsufficientResources: 10023,
    StorageResourcesExceeded: 10047,
} as const;
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
        try {
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
        } catch (error) {
            // No adapter owns this connection yet; release it so startup can exit.
            await connection.close();
            throw error;
        }
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
            // Zero disables expiry. Native startup also migrates saved metadata
            // before restore, when this API is not yet available.
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

    async removeAcknowledged(
        cleanup: AcknowledgedJobStreamCleanup,
    ): Promise<number> {
        // Runtime startup excludes active workers. Still fail closed if the
        // stream/consumer was recreated or its acknowledged position changed.
        const current = planAcknowledgedJobStreamCleanup(await this.inspect());
        if (
            !cleanup.subject.startsWith(
                `${resolveNatsJobSubjectPrefix(this.streamPrefix)}.`,
            ) ||
            !current.some((candidate) => isDeepStrictEqual(candidate, cleanup))
        ) {
            throw new Error(
                "Jobs stream cleanup evidence changed; queued work was preserved",
            );
        }
        const response = await this.manager.streams.purge(this.streamName, {
            filter: cleanup.subject,
            // NATS purge's sequence bound is exclusive. Never send a whole-stream purge.
            seq: cleanup.throughSequence + 1,
        });
        if (!response.success)
            throw new Error("Jobs stream acknowledged cleanup failed");
        return response.purged;
    }

    async probeWritable(): Promise<NatsJobStreamWriteProbe> {
        const messageId = `${NATS_JOB_STREAM_MAINTENANCE_PROBE_MESSAGE_ID_SCOPE}:${randomUUID()}`;
        let acknowledgement: PubAck;
        try {
            // Only a rejected publish can establish the need for resource recovery.
            acknowledgement = await this.jetStream.publish(
                this.probeSubject,
                new Uint8Array(),
                {
                    msgID: messageId,
                    expect: { streamName: this.streamName },
                    timeout: NATS_JOB_STREAM_WRITE_PROBE_TIMEOUT_MS,
                },
            );
        } catch (error) {
            return {
                writable: false,
                resourceLimited: isJetStreamResourceLimitError(error),
                error: formatError(error),
            };
        }

        try {
            // Remove the successful probe without treating cleanup errors as write failures.
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
            return {
                writable: false,
                resourceLimited: false,
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
            const snapshot = mapConsumerSnapshot(consumer);
            const subject = snapshot.filterSubjects[0];
            if (
                snapshot.filterSubjects.length === 1 &&
                subject &&
                isExactJobSubject(subject)
            ) {
                try {
                    // One retained record per subject, not a scan of a large backlog.
                    // The pinned server supports next_by_subj. nats.js forwards
                    // this request unchanged but types getMessage as seq-only.
                    const request = { seq: 1, next_by_subj: subject };
                    const message = await this.manager.streams.getMessage(
                        this.streamName,
                        request,
                    );
                    if (message.subject !== subject)
                        throw new Error("Unexpected retained job subject");
                    snapshot.firstRetainedSequence = message.seq;
                } catch (error) {
                    if (!isMessageNotFound(error)) throw error;
                }
            }
            consumers.push(snapshot);
        }
        return consumers;
    }
}

function mapStreamSnapshot(streamInfo: StreamInfo) {
    return {
        name: streamInfo.config.name,
        created: streamInfo.created,
        workQueue: streamInfo.config.retention === RetentionPolicy.Workqueue,
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

function mapConsumerSnapshot(
    consumer: ConsumerInfo,
): NatsJobStreamSnapshot["consumers"][number] {
    return {
        name: consumer.name,
        created: consumer.created,
        durable: consumer.config.durable_name === consumer.name,
        deliversAll: consumer.config.deliver_policy === DeliverPolicy.All,
        explicitAck: consumer.config.ack_policy === AckPolicy.Explicit,
        filterSubjects: [
            ...(consumer.config.filter_subject
                ? [consumer.config.filter_subject]
                : []),
            ...(consumer.config.filter_subjects ?? []),
        ],
        deliveredStreamSequence: consumer.delivered.stream_seq,
        deliveredConsumerSequence: consumer.delivered.consumer_seq,
        ackFloorStreamSequence: consumer.ack_floor.stream_seq,
        ackFloorConsumerSequence: consumer.ack_floor.consumer_seq,
        pending: consumer.num_pending,
        ackPending: consumer.num_ack_pending,
        redelivered: consumer.num_redelivered,
        firstRetainedSequence: null,
    };
}

function isMessageNotFound(error: unknown): boolean {
    // JetStream's no-message error; stream/permission/transport failures remain failures.
    return (
        (error as { api_error?: { err_code?: number } } | null)?.api_error
            ?.err_code === 10037
    );
}

function isJetStreamResourceLimitError(error: unknown): boolean {
    const apiErrorCode = (
        error as { api_error?: { err_code?: number } } | null | undefined
    )?.api_error?.err_code;
    return (
        apiErrorCode ===
            NATS_RESOURCE_LIMIT_API_ERROR_CODE.InsufficientResources ||
        apiErrorCode ===
            NATS_RESOURCE_LIMIT_API_ERROR_CODE.StorageResourcesExceeded
    );
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
