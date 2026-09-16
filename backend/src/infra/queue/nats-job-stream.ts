import {
    RetentionPolicy,
    StorageType,
    type JetStreamManager,
    type StreamInfo,
} from "nats";
import {
    NATS_JOB_STREAM_MAX_AGE_NANOS,
    resolveNatsJobStreamName,
    resolveNatsJobStreamSubjectFilter,
} from "@artgod/shared/queue/nats-job-stream";

// Creates the jobs stream or reconciles mutable policy on an installed stream.
export async function ensureNatsJobStream(
    manager: JetStreamManager,
    streamPrefix: string,
): Promise<void> {
    const streamName = resolveNatsJobStreamName(streamPrefix);
    let existing: StreamInfo | undefined;
    try {
        existing = await manager.streams.info(streamName);
    } catch (error) {
        if (!isStreamNotFound(error)) throw error;
    }

    if (existing) {
        if (existing.config.max_age !== NATS_JOB_STREAM_MAX_AGE_NANOS) {
            await manager.streams.update(streamName, {
                max_age: NATS_JOB_STREAM_MAX_AGE_NANOS,
            });
        }
        return;
    }

    await manager.streams.add({
        name: streamName,
        subjects: [resolveNatsJobStreamSubjectFilter(streamPrefix)],
        retention: RetentionPolicy.Workqueue,
        storage: StorageType.File,
        max_age: NATS_JOB_STREAM_MAX_AGE_NANOS,
    });
}

function isStreamNotFound(error: unknown): boolean {
    const code = (error as { code?: string | number } | undefined)?.code;
    const apiCode = (error as { api_error?: { code?: number } } | undefined)
        ?.api_error?.code;
    return code === "404" || code === 404 || apiCode === 404;
}
