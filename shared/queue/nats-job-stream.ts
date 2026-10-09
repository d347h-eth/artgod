import policy from "./nats-job-stream-policy.json" with { type: "json" };
import {
    SYNC_WORK_CLASS,
    type SyncWorkClass,
} from "../types/sync-work-class.js";

// Pending work survives downtime. Zero disables JetStream's age-based expiry.
// The native pre-start migration reads this same policy before NATS restores data.
export const NATS_JOB_STREAM_MAX_AGE_NANOS = policy.maxAgeNanos;

const NATS_JOB_STREAM_NAME_SUFFIX = policy.streamNameSuffix;
const NATS_JOB_SUBJECT_TOKEN = policy.subjectToken;
const NATS_JOB_STREAM_WILDCARD_TOKEN = ">";
const NATS_JOB_STREAM_MAINTENANCE_PROBE_TOKEN = "_maintenance_probe";

// Resolves the one jobs stream shared by backend publishers and indexer workers.
export function resolveNatsJobStreamName(streamPrefix: string): string {
    return `${streamPrefix}-${NATS_JOB_STREAM_NAME_SUFFIX}`;
}

// Resolves the common subject prefix below the configured runtime namespace.
export function resolveNatsJobSubjectPrefix(streamPrefix: string): string {
    return `${streamPrefix}.${NATS_JOB_SUBJECT_TOKEN}`;
}

// Resolves the wildcard subject owned by the shared jobs stream.
export function resolveNatsJobStreamSubjectFilter(
    streamPrefix: string,
): string {
    return `${resolveNatsJobSubjectPrefix(streamPrefix)}.${NATS_JOB_STREAM_WILDCARD_TOKEN}`;
}

// Resolves one logical queue subject inside the shared jobs stream.
export function resolveNatsJobSubject(
    streamPrefix: string,
    queueName: string,
    workClass: SyncWorkClass = SYNC_WORK_CLASS.Main,
): string {
    const main = `${resolveNatsJobSubjectPrefix(streamPrefix)}.${queueName}`;
    return workClass === SYNC_WORK_CLASS.Main
        ? main
        : `${main}.${SYNC_WORK_CLASS.GapRepair}`;
}

/** Separate durable capacity keeps a throttled gap job out of main's worker slots. */
export function gapConsumerName(mainConsumer: string): string {
    return `${mainConsumer}-${SYNC_WORK_CLASS.GapRepair}`;
}

// Resolves the isolated subject used to prove that the recovered stream is writable.
export function resolveNatsJobStreamMaintenanceProbeSubject(
    streamPrefix: string,
): string {
    return `${resolveNatsJobSubjectPrefix(streamPrefix)}.${NATS_JOB_STREAM_MAINTENANCE_PROBE_TOKEN}`;
}

/** Exact subjects for one logical queue; inspection includes both worker classes. */
export function resolveNatsJobQueueSubjects(
    streamPrefix: string,
    queueName: string,
): readonly string[] {
    return [
        resolveNatsJobSubject(streamPrefix, queueName, SYNC_WORK_CLASS.Main),
        resolveNatsJobSubject(
            streamPrefix,
            queueName,
            SYNC_WORK_CLASS.GapRepair,
        ),
    ];
}
