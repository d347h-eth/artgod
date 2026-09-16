import policy from "./nats-job-stream-policy.json" with { type: "json" };

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
): string {
    return `${resolveNatsJobSubjectPrefix(streamPrefix)}.${queueName}`;
}

// Resolves the isolated subject used to prove that the recovered stream is writable.
export function resolveNatsJobStreamMaintenanceProbeSubject(
    streamPrefix: string,
): string {
    return `${resolveNatsJobSubjectPrefix(streamPrefix)}.${NATS_JOB_STREAM_MAINTENANCE_PROBE_TOKEN}`;
}
