import {
    JSONCodec,
    RetentionPolicy,
    StorageType,
    connect,
    type JetStreamManager,
} from "nats";
import type { SyncBackfillRangeCommand } from "../../application/use-cases/sync-backfill/schedule-sync-backfill.js";

type BackfillSyncPayload = {
    fromBlock: number;
    toBlock: number;
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
    private readonly streamName: string;
    private readonly subjectPrefix: string;

    constructor(
        private readonly natsUrl: string,
        private readonly streamPrefix: string,
    ) {
        this.streamName = `${streamPrefix}-jobs`;
        this.subjectPrefix = `${streamPrefix}.jobs`;
    }

    async publishBackfillRanges(
        commands: SyncBackfillRangeCommand[],
    ): Promise<void> {
        if (commands.length === 0) return;
        const connection = await connect({ servers: this.natsUrl });
        try {
            const js = connection.jetstream();
            const jsm = await connection.jetstreamManager();
            await ensureStream(jsm, this.streamName, this.subjectPrefix);
            const codec = JSONCodec<JobEnvelope<BackfillSyncPayload>>();
            const subject = `${this.subjectPrefix}.${QUEUE_NAMES.BackfillSync}`;
            const nonce = Date.now();
            for (const command of commands) {
                const jobId = buildBackfillJobId(command, nonce);
                const envelope: JobEnvelope<BackfillSyncPayload> = {
                    jobId,
                    kind: SYNC_JOB_KIND.BackfillRange,
                    queue: QUEUE_NAMES.BackfillSync,
                    payload: {
                        fromBlock: command.fromBlock,
                        toBlock: command.toBlock,
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
        } finally {
            await connection.drain().catch(() => undefined);
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

async function ensureStream(
    jsm: JetStreamManager,
    streamName: string,
    subjectPrefix: string,
): Promise<void> {
    try {
        await jsm.streams.info(streamName);
        return;
    } catch {}
    await jsm.streams.add({
        name: streamName,
        subjects: [`${subjectPrefix}.>`],
        retention: RetentionPolicy.Workqueue,
        storage: StorageType.File,
        max_age: 7 * 24 * 60 * 60 * 1_000_000_000,
    });
}
