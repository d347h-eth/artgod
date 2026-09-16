import { NATS_JOB_STREAM_MAX_AGE_NANOS } from "@artgod/shared/queue/nats-job-stream";

export const NATS_JOB_STREAM_MAINTENANCE_EVENT = {
    UpgradeObservation: "upgrade_observation",
    UpgradeWriteProbe: "upgrade_write_probe",
    PolicyReconciled: "policy_reconciled",
    PurgeStarted: "purge_started",
    PurgeCompleted: "purge_completed",
    WriteVerified: "write_verified",
    Completed: "completed",
    Failed: "failed",
} as const;

export type NatsJobStreamMaintenanceEventKind =
    (typeof NATS_JOB_STREAM_MAINTENANCE_EVENT)[keyof typeof NATS_JOB_STREAM_MAINTENANCE_EVENT];

export type NatsJobStreamConsumerSnapshot = {
    name: string;
    created: string;
    durable: boolean;
    deliversAll: boolean;
    explicitAck: boolean;
    filterSubjects: string[];
    deliveredStreamSequence: number;
    deliveredConsumerSequence: number;
    ackFloorStreamSequence: number;
    ackFloorConsumerSequence: number;
    pending: number;
    ackPending: number;
    redelivered: number;
    firstRetainedSequence: number | null;
};

export type NatsJobStreamSnapshot = {
    stream: {
        name: string;
        created: string;
        workQueue: boolean;
        maxAgeNanos: number;
        messages: number;
        bytes: number;
        firstSequence: number;
        firstTimestamp: string;
        lastSequence: number;
        lastTimestamp: string;
        consumerCount: number;
    } | null;
    account: { storageBytes: number; maxStorageBytes: number };
    consumers: NatsJobStreamConsumerSnapshot[];
};

export type NatsJobStreamWriteProbe = {
    writable: boolean;
    resourceLimited: boolean;
    error: string | null;
};

// A deletion is always one exact subject, bounded by a fully acknowledged
// consumer position. The adapter must revalidate this evidence before mutation.
export type AcknowledgedJobStreamCleanup = {
    streamCreated: string;
    subject: string;
    throughSequence: number;
    consumer: NatsJobStreamConsumerSnapshot;
};

export type NatsJobStreamMaintenanceEvent = {
    kind: NatsJobStreamMaintenanceEventKind;
    snapshot?: NatsJobStreamSnapshot;
    writeProbe?: NatsJobStreamWriteProbe;
    cleanup?: AcknowledgedJobStreamCleanup;
    purgedMessages?: number;
};

export type NatsJobStreamMaintenanceResult = {
    initial: NatsJobStreamSnapshot;
    initialWriteProbe: NatsJobStreamWriteProbe | null;
    afterPolicy: NatsJobStreamSnapshot;
    final: NatsJobStreamSnapshot;
    purged: boolean;
    purgedMessages: number;
};

type NatsJobStreamAdministrationPort = {
    inspect(): Promise<NatsJobStreamSnapshot>;
    reconcileMaxAge(maxAgeNanos: number): Promise<void>;
    removeAcknowledged(cleanup: AcknowledgedJobStreamCleanup): Promise<number>;
    probeWritable(): Promise<NatsJobStreamWriteProbe>;
};

// Runs before producers/consumers. Storage pressure never authorizes dropping
// processable work; if completed leftovers cannot recover writes, startup fails.
export class MaintainNatsJobStream {
    constructor(
        private readonly administration: NatsJobStreamAdministrationPort,
        private readonly reporter: {
            report(event: NatsJobStreamMaintenanceEvent): void;
        },
    ) {}

    async execute(): Promise<NatsJobStreamMaintenanceResult> {
        const initial = await this.administration.inspect();
        this.reporter.report({
            kind: NATS_JOB_STREAM_MAINTENANCE_EVENT.UpgradeObservation,
            snapshot: initial,
        });
        const initialWriteProbe = initial.stream
            ? await this.administration.probeWritable()
            : null;
        if (initialWriteProbe) {
            this.reporter.report({
                kind: NATS_JOB_STREAM_MAINTENANCE_EVENT.UpgradeWriteProbe,
                writeProbe: initialWriteProbe,
            });
            assertRecoverableProbe(initialWriteProbe);
        }

        await this.administration.reconcileMaxAge(
            NATS_JOB_STREAM_MAX_AGE_NANOS,
        );
        const afterPolicy = await this.administration.inspect();
        if (afterPolicy.stream?.maxAgeNanos !== NATS_JOB_STREAM_MAX_AGE_NANOS) {
            throw new Error("Jobs stream age policy was not reconciled");
        }
        this.reporter.report({
            kind: NATS_JOB_STREAM_MAINTENANCE_EVENT.PolicyReconciled,
            snapshot: afterPolicy,
        });

        // An unrelated failure must not fall through from an earlier resource
        // error into deletion. A successful probe also cleans up its own message.
        const beforeCleanup = await this.administration.probeWritable();
        assertRecoverableProbe(beforeCleanup);
        let purgedMessages = 0;
        const cleanups = planAcknowledgedJobStreamCleanup(afterPolicy);
        for (const cleanup of cleanups) {
            this.reporter.report({
                kind: NATS_JOB_STREAM_MAINTENANCE_EVENT.PurgeStarted,
                cleanup,
            });
            const removed =
                await this.administration.removeAcknowledged(cleanup);
            purgedMessages += removed;
            this.reporter.report({
                kind: NATS_JOB_STREAM_MAINTENANCE_EVENT.PurgeCompleted,
                cleanup,
                purgedMessages: removed,
            });
        }

        const writeProbe =
            cleanups.length > 0
                ? await this.administration.probeWritable()
                : beforeCleanup;
        if (!writeProbe.writable) {
            throw new Error(
                `Jobs stream remains unwritable; queued work was preserved: ${writeProbe.error ?? "unknown error"}`,
            );
        }
        const final = await this.administration.inspect();
        this.reporter.report({
            kind: NATS_JOB_STREAM_MAINTENANCE_EVENT.WriteVerified,
            snapshot: final,
            writeProbe,
        });
        this.reporter.report({
            kind: NATS_JOB_STREAM_MAINTENANCE_EVENT.Completed,
            snapshot: final,
            purgedMessages,
        });
        return {
            initial,
            initialWriteProbe,
            afterPolicy,
            final,
            purged: purgedMessages > 0,
            purgedMessages,
        };
    }
}

// A healthy work queue has no retained records behind its ACK floor. Require
// the entire delivered prefix to be acknowledged; do not infer completion from
// age, account storage, total pending counts, or a consumer's delivery position.
export function planAcknowledgedJobStreamCleanup(
    snapshot: NatsJobStreamSnapshot,
): AcknowledgedJobStreamCleanup[] {
    const { stream, consumers } = snapshot;
    if (
        !stream?.workQueue ||
        !stream.created ||
        stream.maxAgeNanos !== NATS_JOB_STREAM_MAX_AGE_NANOS ||
        stream.consumerCount !== consumers.length
    )
        return [];
    // Unknown/wildcard ownership could overlap an otherwise exact subject.
    if (
        consumers.some(
            (c) =>
                c.filterSubjects.length !== 1 ||
                !isExactJobSubject(c.filterSubjects[0]!),
        )
    )
        return [];

    return consumers.flatMap((consumer) => {
        const subject = consumer.filterSubjects[0]!;
        const floor = consumer.ackFloorStreamSequence;
        if (
            !consumer.durable ||
            !consumer.deliversAll ||
            !consumer.explicitAck ||
            !consumer.created ||
            consumer.ackPending !== 0 ||
            consumer.redelivered !== 0 ||
            !Number.isSafeInteger(consumer.pending) ||
            consumer.pending < 0 ||
            !Number.isSafeInteger(floor) ||
            floor <= 0 ||
            floor >= Number.MAX_SAFE_INTEGER ||
            floor > stream.lastSequence ||
            consumer.deliveredStreamSequence !== floor ||
            !Number.isSafeInteger(consumer.ackFloorConsumerSequence) ||
            consumer.ackFloorConsumerSequence <= 0 ||
            consumer.deliveredConsumerSequence !==
                consumer.ackFloorConsumerSequence ||
            consumer.firstRetainedSequence === null ||
            !Number.isSafeInteger(consumer.firstRetainedSequence) ||
            consumer.firstRetainedSequence <= 0 ||
            consumer.firstRetainedSequence > floor ||
            consumers.filter((c) => c.filterSubjects[0] === subject).length !==
                1
        )
            return [];
        return [
            {
                streamCreated: stream.created,
                subject,
                throughSequence: floor,
                consumer,
            },
        ];
    });
}

export function isExactJobSubject(subject: string): boolean {
    return (
        subject.length > 0 &&
        !/[\s*>]/u.test(subject) &&
        subject.split(".").every((token) => token.length > 0)
    );
}

function assertRecoverableProbe(probe: NatsJobStreamWriteProbe): void {
    if (!probe.writable && !probe.resourceLimited) {
        throw new Error(
            `Jobs stream write probe failed outside storage recovery: ${probe.error ?? "unknown error"}`,
        );
    }
}
