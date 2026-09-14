import {
    NATS_JOB_STREAM_MAX_AGE_NANOS,
    resolveNatsJobSubject,
    resolveNatsJobStreamName,
} from "@artgod/shared/queue/nats-job-stream";
import type {
    NatsJobStreamConsumerSnapshot,
    NatsJobStreamSnapshot,
} from "../../src/application/queue/maintain-nats-job-stream.js";
export const PREFIX = "test";
export const SUBJECT = resolveNatsJobSubject(PREFIX, "processed");
export function consumer(
    overrides: Partial<NatsJobStreamConsumerSnapshot> = {},
): NatsJobStreamConsumerSnapshot {
    return {
        name: "processed",
        created: "2026-08-01T00:00:00Z",
        durable: true,
        deliversAll: true,
        explicitAck: true,
        filterSubjects: [SUBJECT],
        deliveredStreamSequence: 50,
        ackFloorStreamSequence: 50,
        deliveredConsumerSequence: 20,
        ackFloorConsumerSequence: 20,
        pending: 7,
        ackPending: 0,
        redelivered: 0,
        firstRetainedSequence: 1,
        ...overrides,
    };
}

export function snapshot(consumers = [consumer()]): NatsJobStreamSnapshot {
    return {
        stream: {
            name: resolveNatsJobStreamName(PREFIX),
            created: "2026-08-01T00:00:00Z",
            workQueue: true,
            maxAgeNanos: NATS_JOB_STREAM_MAX_AGE_NANOS,
            messages: 27,
            bytes: 200,
            firstSequence: 1,
            lastSequence: 99,
            consumerCount: consumers.length,
            firstTimestamp: "2026-08-01T00:00:00Z",
            lastTimestamp: "2026-08-02T00:00:00Z",
        },
        account: { storageBytes: 200, maxStorageBytes: 100 },
        consumers,
    };
}
