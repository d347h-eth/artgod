import { JSONCodec, connect } from "nats";
import { NOOP_APM, type ApmPort } from "@artgod/shared/observability/apm";
import { resolveNatsJobSubjectPrefix } from "@artgod/shared/queue/nats-job-stream";
import {
    BACKFILL_ORDER_MAINTENANCE_POLICY,
    BACKFILL_SOURCE,
    type BackfillOrderMaintenancePolicy,
    type BackfillSource,
} from "@artgod/shared/types/sync-backfill";
import type { SyncBackfillRangeCommand } from "../../application/use-cases/sync-backfill/schedule-sync-backfill.js";
import { SYNC_BACKFILL_SPAN_ATTRIBUTE } from "../../application/use-cases/sync-backfill/sync-backfill-observability.js";
import { ensureNatsJobStream } from "../queue/nats-job-stream.js";

type BackfillSyncPayload = {
    fromBlock: number;
    toBlock: number;
    source: BackfillSource;
    orderMaintenancePolicy: BackfillOrderMaintenancePolicy;
};

type JobEnvelope<TPayload> = {
    jobId: string;
    kind: string;
    queue: string;
    payload: TPayload;
    attempt: number;
    scheduledAt: number;
    chainId: number;
    collectionId?: number;
};

const QUEUE_NAMES = {
    BackfillSync: "events-sync-backfill",
} as const;

const SYNC_JOB_KIND = {
    BackfillRange: "sync.backfill.range",
} as const;

export class NatsSyncBackfillCommandQueue {
    private readonly subjectPrefix: string;

    constructor(
        private readonly natsUrl: string,
        private readonly streamPrefix: string,
        private readonly apm: ApmPort = NOOP_APM,
    ) {
        this.subjectPrefix = resolveNatsJobSubjectPrefix(streamPrefix);
    }

    async publishBackfillRanges(
        commands: SyncBackfillRangeCommand[],
    ): Promise<void> {
        if (commands.length === 0) return;
        const attributes = {
            [SYNC_BACKFILL_SPAN_ATTRIBUTE.CommandsCount]: commands.length,
        };
        // Open the NATS connection only for the manual backfill publish operation.
        const connection = await this.apm.withSpan(
            "backend.sync_backfill.nats.connect",
            attributes,
            () => connect({ servers: this.natsUrl }),
        );
        try {
            const js = connection.jetstream();
            const jsm = await this.apm.withSpan(
                "backend.sync_backfill.nats.jetstream_manager",
                attributes,
                () => connection.jetstreamManager(),
            );
            await this.apm.withSpan(
                "backend.sync_backfill.nats.ensure_stream",
                attributes,
                () => ensureNatsJobStream(jsm, this.streamPrefix),
            );
            const codec = JSONCodec<JobEnvelope<BackfillSyncPayload>>();
            const subject = `${this.subjectPrefix}.${QUEUE_NAMES.BackfillSync}`;
            const nonce = Date.now();
            await this.apm.withSpan(
                "backend.sync_backfill.nats.publish_ranges",
                attributes,
                async () => {
                    for (const command of commands) {
                        const jobId = buildBackfillJobId(command, nonce);
                        const envelope: JobEnvelope<BackfillSyncPayload> = {
                            jobId,
                            kind: SYNC_JOB_KIND.BackfillRange,
                            queue: QUEUE_NAMES.BackfillSync,
                            payload: {
                                fromBlock: command.fromBlock,
                                toBlock: command.toBlock,
                                source: BACKFILL_SOURCE.ManualHistorical,
                                orderMaintenancePolicy:
                                    BACKFILL_ORDER_MAINTENANCE_POLICY.SkipGlobalMakerRevalidation,
                            },
                            attempt: 0,
                            scheduledAt: Date.now(),
                            chainId: command.chainId,
                            collectionId: command.collectionId ?? undefined,
                        };
                        await js.publish(subject, codec.encode(envelope), {
                            msgID: jobId,
                        });
                    }
                },
            );
        } finally {
            await this.apm
                .withSpan("backend.sync_backfill.nats.drain", attributes, () =>
                    connection.drain(),
                )
                .catch(() => undefined);
        }
    }
}

function buildBackfillJobId(
    command: SyncBackfillRangeCommand,
    nonce: number,
): string {
    const scope = command.collectionId ?? "all";
    return `sync:manual:${command.chainId}:${scope}:${command.fromBlock}-${command.toBlock}:${nonce}`;
}
