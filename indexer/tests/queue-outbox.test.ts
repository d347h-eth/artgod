import { beforeEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { drainQueueOutbox } from "../src/application/queue-outbox/drainer.js";
import {
    DOMAIN_JOB_KIND,
    METADATA_STATS_RECOMPUTE_REASON,
    type MetadataStatsRecomputePayload,
} from "../src/domain/domain-jobs.js";
import type { JobEnvelope } from "../src/domain/jobs.js";
import { QUEUE_OUTBOX_STATUS } from "../src/domain/queue-outbox.js";
import { QUEUE_NAMES, type QueueName } from "../src/domain/queues.js";
import { SqliteQueueOutbox } from "../src/infra/queue/sqlite-queue-outbox.js";
import type {
    QueueMessage,
    QueuePort,
    SubscribeOptions,
} from "../src/ports/queue.js";

const CHAIN_ID = 1;
const COLLECTION_ID = 7;

describe("queue outbox drainer", () => {
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });

    it("publishes due rows and marks them sent", async () => {
        const outbox = new SqliteQueueOutbox();
        const queue = new RecordingQueue();
        const job = buildStatsJob();

        outbox.enqueueJob(job);

        const published = await drainQueueOutbox(outbox, queue, { limit: 10 });

        expect(published).toBe(1);
        expect(queue.published).toEqual([
            {
                queue: QUEUE_NAMES.MetadataStats,
                jobId: job.jobId,
            },
        ]);
        expect(selectOutboxStatus(job.jobId)).toBe(QUEUE_OUTBOX_STATUS.Sent);
    });
});

class RecordingQueue implements QueuePort {
    readonly published: Array<{ queue: QueueName; jobId: string }> = [];

    async publish<TPayload>(
        queue: QueueName,
        message: JobEnvelope<TPayload>,
    ): Promise<void> {
        this.published.push({ queue, jobId: message.jobId });
    }

    async subscribe<TPayload>(
        _queue: QueueName,
        _handler: (message: QueueMessage<TPayload>) => Promise<void>,
        _options: SubscribeOptions,
    ): Promise<() => Promise<void>> {
        throw new Error("RecordingQueue does not support subscribe");
    }

    async close(): Promise<void> {}
}

async function createTempDbPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "artgod-queue-outbox-"));
    return join(dir, "main.sqlite");
}

function buildStatsJob(): JobEnvelope<MetadataStatsRecomputePayload> {
    return {
        jobId: "metadata-stats-test-job",
        kind: DOMAIN_JOB_KIND.MetadataStatsRecompute,
        queue: QUEUE_NAMES.MetadataStats,
        payload: {
            chainId: CHAIN_ID,
            collectionId: COLLECTION_ID,
            reason: METADATA_STATS_RECOMPUTE_REASON.MetadataRefresh,
            sourceJobId: "queue-outbox-test",
        },
        attempt: 0,
        scheduledAt: 0,
        chainId: CHAIN_ID,
        collectionId: COLLECTION_ID,
        traceId: "queue-outbox-test-trace",
    };
}

function selectOutboxStatus(jobId: string): string | null {
    const row = db
        .prepare<
            [string]
        >("SELECT status FROM queue_outbox WHERE job_id = ? LIMIT 1")
        .get(jobId) as { status: string } | undefined;
    return row?.status ?? null;
}
