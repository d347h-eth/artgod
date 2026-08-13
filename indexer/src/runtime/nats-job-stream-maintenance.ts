import { logger } from "@artgod/shared/utils";
import {
    MaintainNatsJobStream,
    NATS_JOB_STREAM_MAINTENANCE_EVENT,
    type NatsJobStreamMaintenanceEvent,
    type NatsJobStreamSnapshot,
} from "../application/queue/maintain-nats-job-stream.js";
import { loadNatsJobStreamMaintenanceConfig } from "../config/nats-job-stream-maintenance.js";
import { NatsJobStreamMaintenanceAdapter } from "../infra/queue/nats-job-stream-maintenance.js";

const NATS_JOB_STREAM_MAINTENANCE_LOG_COMPONENT =
    "IndexerNatsJobStreamMaintenance";

const NATS_JOB_STREAM_MAINTENANCE_MESSAGE = {
    [NATS_JOB_STREAM_MAINTENANCE_EVENT.UpgradeObservation]:
        "Observed jobs stream after NATS upgrade restore",
    [NATS_JOB_STREAM_MAINTENANCE_EVENT.UpgradeWriteProbe]:
        "Checked jobs stream write health before policy recovery",
    [NATS_JOB_STREAM_MAINTENANCE_EVENT.PolicyReconciled]:
        "Reconciled jobs stream retention policy",
    [NATS_JOB_STREAM_MAINTENANCE_EVENT.ExpiryProgress]:
        "Waiting for jobs stream MaxAge cleanup",
    [NATS_JOB_STREAM_MAINTENANCE_EVENT.PurgeStarted]:
        "Jobs stream remains over its storage limit; starting recovery purge",
    [NATS_JOB_STREAM_MAINTENANCE_EVENT.PurgeCompleted]:
        "Completed jobs stream recovery purge",
    [NATS_JOB_STREAM_MAINTENANCE_EVENT.WriteVerified]:
        "Verified jobs stream write health",
    [NATS_JOB_STREAM_MAINTENANCE_EVENT.Completed]:
        "Jobs stream startup maintenance completed",
    [NATS_JOB_STREAM_MAINTENANCE_EVENT.Failed]:
        "Jobs stream startup maintenance failed",
} as const;

async function main(): Promise<void> {
    const config = loadNatsJobStreamMaintenanceConfig();
    const adapter = await NatsJobStreamMaintenanceAdapter.connect(config);
    try {
        const maintenance = new MaintainNatsJobStream(
            adapter,
            { report: reportMaintenanceEvent },
            {
                now: () => Date.now(),
                sleep: (delayMs) =>
                    new Promise((resolve) => setTimeout(resolve, delayMs)),
            },
        );
        await maintenance.execute();
    } finally {
        await adapter.close();
    }
}

function reportMaintenanceEvent(event: NatsJobStreamMaintenanceEvent): void {
    const meta = {
        component: NATS_JOB_STREAM_MAINTENANCE_LOG_COMPONENT,
        action: event.kind,
        ...(event.snapshot
            ? summarizeSnapshot(event.snapshot, event.kind)
            : {}),
        ...(event.writeProbe ? { writeProbe: event.writeProbe } : {}),
        ...(event.purgedMessages !== undefined
            ? { purgedMessages: event.purgedMessages }
            : {}),
    };
    const message = NATS_JOB_STREAM_MAINTENANCE_MESSAGE[event.kind];
    if (event.kind === NATS_JOB_STREAM_MAINTENANCE_EVENT.PurgeStarted) {
        logger.warn(message, meta);
        return;
    }
    logger.info(message, meta);
}

function summarizeSnapshot(
    snapshot: NatsJobStreamSnapshot,
    eventKind: NatsJobStreamMaintenanceEvent["kind"],
) {
    const consumerTotals = snapshot.consumers.reduce(
        (totals, consumer) => ({
            pending: totals.pending + consumer.pending,
            ackPending: totals.ackPending + consumer.ackPending,
            redelivered: totals.redelivered + consumer.redelivered,
        }),
        { pending: 0, ackPending: 0, redelivered: 0 },
    );
    const includeConsumers =
        eventKind === NATS_JOB_STREAM_MAINTENANCE_EVENT.UpgradeObservation ||
        eventKind === NATS_JOB_STREAM_MAINTENANCE_EVENT.Completed;
    return {
        stream: snapshot.stream,
        account: snapshot.account,
        consumerTotals,
        ...(includeConsumers ? { consumers: snapshot.consumers } : {}),
    };
}

main().catch((error) => {
    logger.error("Jobs stream startup maintenance failed", {
        component: NATS_JOB_STREAM_MAINTENANCE_LOG_COMPONENT,
        action: NATS_JOB_STREAM_MAINTENANCE_EVENT.Failed,
        error: String(error),
    });
    process.exitCode = 1;
});
