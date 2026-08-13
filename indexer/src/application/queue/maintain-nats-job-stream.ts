import { NATS_JOB_STREAM_MAX_AGE_NANOS } from "@artgod/shared/queue/nats-job-stream";

// Owns the lifecycle event vocabulary emitted by the startup maintenance use case.
export const NATS_JOB_STREAM_MAINTENANCE_EVENT = {
    UpgradeObservation: "upgrade_observation",
    UpgradeWriteProbe: "upgrade_write_probe",
    PolicyReconciled: "policy_reconciled",
    ExpiryProgress: "expiry_progress",
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
    filterSubject: string | null;
    deliveredStreamSequence: number;
    ackFloorStreamSequence: number;
    pending: number;
    ackPending: number;
    redelivered: number;
};

export type NatsJobStreamSnapshot = {
    stream: {
        name: string;
        maxAgeNanos: number;
        messages: number;
        bytes: number;
        firstSequence: number;
        firstTimestamp: string;
        lastSequence: number;
        lastTimestamp: string;
        consumerCount: number;
    } | null;
    account: {
        storageBytes: number;
        maxStorageBytes: number;
    };
    consumers: NatsJobStreamConsumerSnapshot[];
};

export type NatsJobStreamWriteProbe = {
    writable: boolean;
    resourceLimited: boolean;
    error: string | null;
};

export type NatsJobStreamMaintenanceEvent = {
    kind: NatsJobStreamMaintenanceEventKind;
    snapshot?: NatsJobStreamSnapshot;
    writeProbe?: NatsJobStreamWriteProbe;
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
    purge(): Promise<number>;
    probeWritable(): Promise<NatsJobStreamWriteProbe>;
};

type NatsJobStreamMaintenanceReporterPort = {
    report(event: NatsJobStreamMaintenanceEvent): void;
};

type NatsJobStreamMaintenanceClockPort = {
    now(): number;
    sleep(delayMs: number): Promise<void>;
};

export type NatsJobStreamMaintenancePolicy = {
    expiryPollIntervalMs: number;
    expiryStallTimeoutMs: number;
    expiryMaxWaitMs: number;
};

// Bounds startup waiting while allowing active MaxAge cleanup to keep making progress.
export const DEFAULT_NATS_JOB_STREAM_MAINTENANCE_POLICY: NatsJobStreamMaintenancePolicy =
    {
        expiryPollIntervalMs: 5_000,
        expiryStallTimeoutMs: 30_000,
        expiryMaxWaitMs: 10 * 60 * 1_000,
    };

// Reconciles the jobs stream before any normal queue producer is allowed to start.
export class MaintainNatsJobStream {
    constructor(
        private readonly administration: NatsJobStreamAdministrationPort,
        private readonly reporter: NatsJobStreamMaintenanceReporterPort,
        private readonly clock: NatsJobStreamMaintenanceClockPort,
        private readonly policy: NatsJobStreamMaintenancePolicy = DEFAULT_NATS_JOB_STREAM_MAINTENANCE_POLICY,
    ) {}

    async execute(): Promise<NatsJobStreamMaintenanceResult> {
        // Capture the exact restored state before the release changes stream policy.
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
            if (
                !initialWriteProbe.writable &&
                !initialWriteProbe.resourceLimited
            ) {
                throw new Error(
                    `Initial jobs stream write probe failed outside the storage-limit recovery path: ${initialWriteProbe.error ?? "unknown error"}`,
                );
            }
        }

        // Apply the canonical policy to both newly created and previously installed streams.
        await this.administration.reconcileMaxAge(
            NATS_JOB_STREAM_MAX_AGE_NANOS,
        );
        const afterPolicy = await this.administration.inspect();
        this.assertPolicyReconciled(afterPolicy);
        this.reporter.report({
            kind: NATS_JOB_STREAM_MAINTENANCE_EVENT.PolicyReconciled,
            snapshot: afterPolicy,
        });

        const afterExpiry = await this.waitForWriteRecovery(
            afterPolicy,
            initialWriteProbe,
        );
        const recovery = await this.ensureWritable(
            afterExpiry.snapshot,
            afterExpiry.writeProbe,
        );

        this.reporter.report({
            kind: NATS_JOB_STREAM_MAINTENANCE_EVENT.Completed,
            snapshot: recovery.final,
            purgedMessages: recovery.purgedMessages,
        });
        return {
            initial,
            initialWriteProbe,
            afterPolicy,
            final: recovery.final,
            purged: recovery.purged,
            purgedMessages: recovery.purgedMessages,
        };
    }

    private async waitForWriteRecovery(
        startingSnapshot: NatsJobStreamSnapshot,
        initialWriteProbe: NatsJobStreamWriteProbe | null,
    ): Promise<{
        snapshot: NatsJobStreamSnapshot;
        writeProbe: NatsJobStreamWriteProbe | null;
    }> {
        let current = startingSnapshot;
        const recoveryRequired =
            initialWriteProbe?.resourceLimited || isOverStorageLimit(current);
        if (!recoveryRequired) {
            return { snapshot: current, writeProbe: null };
        }

        const startedAt = this.clock.now();
        let lastProgressAt = startedAt;
        let previousStorageBytes = current.account.storageBytes;
        let writeProbe = initialWriteProbe;

        while (true) {
            const now = this.clock.now();
            if (
                now - startedAt >= this.policy.expiryMaxWaitMs ||
                now - lastProgressAt >= this.policy.expiryStallTimeoutMs
            ) {
                return { snapshot: current, writeProbe };
            }

            await this.clock.sleep(this.policy.expiryPollIntervalMs);
            current = await this.administration.inspect();
            writeProbe = await this.administration.probeWritable();
            if (current.account.storageBytes < previousStorageBytes) {
                lastProgressAt = this.clock.now();
                previousStorageBytes = current.account.storageBytes;
            }
            this.reporter.report({
                kind: NATS_JOB_STREAM_MAINTENANCE_EVENT.ExpiryProgress,
                snapshot: current,
                writeProbe,
            });
            if (writeProbe.writable) {
                return { snapshot: current, writeProbe };
            }
            if (!writeProbe.resourceLimited) {
                throw new Error(
                    `Jobs stream write verification failed during MaxAge cleanup: ${writeProbe.error ?? "unknown error"}`,
                );
            }
        }
    }

    private async ensureWritable(
        snapshot: NatsJobStreamSnapshot,
        observedProbe: NatsJobStreamWriteProbe | null,
    ): Promise<{
        final: NatsJobStreamSnapshot;
        purged: boolean;
        purgedMessages: number;
    }> {
        if (observedProbe?.writable) {
            const final = await this.administration.inspect();
            this.reporter.report({
                kind: NATS_JOB_STREAM_MAINTENANCE_EVENT.WriteVerified,
                snapshot: final,
                writeProbe: observedProbe,
            });
            return { final, purged: false, purgedMessages: 0 };
        }

        if (!isOverStorageLimit(snapshot)) {
            const probe =
                observedProbe ?? (await this.administration.probeWritable());
            if (probe.writable) {
                const final = await this.administration.inspect();
                this.reporter.report({
                    kind: NATS_JOB_STREAM_MAINTENANCE_EVENT.WriteVerified,
                    snapshot: final,
                    writeProbe: probe,
                });
                return { final, purged: false, purgedMessages: 0 };
            }
            if (!probe.resourceLimited) {
                throw new Error(
                    `Jobs stream write verification failed: ${probe.error ?? "unknown error"}`,
                );
            }
        }

        const stream = snapshot.stream;
        if (!stream || stream.messages === 0) {
            throw new Error(
                "JetStream remains over its storage limit, but the jobs stream has no messages available for recovery purge",
            );
        }

        this.reporter.report({
            kind: NATS_JOB_STREAM_MAINTENANCE_EVENT.PurgeStarted,
            snapshot,
        });
        const purgedMessages = await this.administration.purge();
        const afterPurge = await this.administration.inspect();
        this.reporter.report({
            kind: NATS_JOB_STREAM_MAINTENANCE_EVENT.PurgeCompleted,
            snapshot: afterPurge,
            purgedMessages,
        });

        const probe = await this.administration.probeWritable();
        if (!probe.writable) {
            throw new Error(
                `Jobs stream remained unwritable after purging ${purgedMessages} messages: ${probe.error ?? "unknown error"}`,
            );
        }

        const final = await this.administration.inspect();
        this.reporter.report({
            kind: NATS_JOB_STREAM_MAINTENANCE_EVENT.WriteVerified,
            snapshot: final,
            writeProbe: probe,
        });
        return { final, purged: true, purgedMessages };
    }

    private assertPolicyReconciled(snapshot: NatsJobStreamSnapshot): void {
        if (!snapshot.stream) {
            throw new Error(
                "Jobs stream is missing after policy reconciliation",
            );
        }
        if (snapshot.stream.maxAgeNanos !== NATS_JOB_STREAM_MAX_AGE_NANOS) {
            throw new Error(
                `Jobs stream MaxAge is ${snapshot.stream.maxAgeNanos}ns after reconciliation; expected ${NATS_JOB_STREAM_MAX_AGE_NANOS}ns`,
            );
        }
    }
}

function isOverStorageLimit(snapshot: NatsJobStreamSnapshot): boolean {
    const maxStorageBytes = snapshot.account.maxStorageBytes;
    return (
        maxStorageBytes >= 0 && snapshot.account.storageBytes > maxStorageBytes
    );
}
