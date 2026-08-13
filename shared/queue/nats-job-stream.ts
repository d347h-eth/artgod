const NANOSECONDS_PER_SECOND = 1_000_000_000;
const SECONDS_PER_HOUR = 60 * 60;

// Jobs are disposable transport state and must not remain queued beyond one day.
export const NATS_JOB_STREAM_MAX_AGE_HOURS = 24;

// JetStream expresses stream age limits in nanoseconds.
export const NATS_JOB_STREAM_MAX_AGE_NANOS =
    NATS_JOB_STREAM_MAX_AGE_HOURS *
    SECONDS_PER_HOUR *
    NANOSECONDS_PER_SECOND;

const NATS_JOB_STREAM_NAME_SUFFIX = "jobs";
const NATS_JOB_SUBJECT_TOKEN = "jobs";
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
