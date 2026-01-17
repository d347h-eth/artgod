import { describe, it, expect } from "vitest";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { db, setDbPath } from "@artgod/shared/database";
import { NatsJetStreamQueue } from "../src/infra/queue/nats.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import {
    SYNC_JOB_KIND,
    type BackfillSyncPayload,
} from "../src/domain/sync-jobs.js";
import type { JobEnvelope } from "../src/domain/jobs.js";
import { loadSmokeConfig } from "./helpers/smoke-config.js";
import {
    createTempDbPath,
    startNats,
    startWorker,
    waitFor,
} from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

describe("indexer smoke", () => {
    const runtimeEnv = loadTestEnv();
    const config = loadSmokeConfig(runtimeEnv);

    it("processes a small backfill range", async () => {
        const dbPath = await createTempDbPath();
        setDbPath(dbPath);
        const migrations = createMigrationRunner();
        await migrations.runMigrations();

        const nats = await startNats(config.natsPort);
        const streamPrefix = `artgod-test-${Date.now()}`;
        const env = {
            ...runtimeEnv,
            ARTGOD_DB_PATH: dbPath,
            NATS_URL: nats.url,
            NATS_STREAM_PREFIX: streamPrefix,
            RPC_URL: config.rpcUrl,
            CHAIN_ID: String(config.chainId),
            TARGET_COLLECTIONS: config.collections,
            REORG_DEPTH: "3",
            BACKFILL_BATCH_SIZE: "3",
            LOG_CHUNK_SIZE: "500",
        };

        const cwd = process.cwd();
        const syncWorker = await startWorker(
            "sync-worker",
            "dev:sync-worker",
            env,
            cwd,
        );
        const domainWorker = await startWorker(
            "domain-worker",
            "dev:domain-worker",
            env,
            cwd,
        );

        const queue = await NatsJetStreamQueue.connect({
            natsUrl: nats.url,
            streamPrefix,
        });

        const job: JobEnvelope<BackfillSyncPayload> = {
            jobId: `smoke-backfill:${Date.now()}`,
            kind: SYNC_JOB_KIND.BackfillRange,
            queue: QUEUE_NAMES.BackfillSync,
            payload: {
                fromBlock: config.fromBlock,
                toBlock: config.toBlock,
            },
            attempt: 0,
            scheduledAt: Date.now(),
            chainId: config.chainId,
        };
        await queue.publish(QUEUE_NAMES.BackfillSync, job);
        await queue.close();

        await waitFor(() => count("blocks") > 0);
        await waitFor(() => count("nft_transfer_events") > 0);
        await waitFor(() => count("activities") > 0);

        expect(count("blocks")).toBeGreaterThan(0);
        expect(count("nft_transfer_events")).toBeGreaterThan(0);
        expect(count("activities")).toBeGreaterThan(0);
        await syncWorker.stop();
        await domainWorker.stop();
        await nats.stop();
    });
});

function count(table: string): number {
    const row = db.prepare(`SELECT COUNT(1) as count FROM ${table}`).get() as {
        count: number;
    };
    return row.count;
}
