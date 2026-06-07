import { describe, it, expect } from "vitest";
import { RPC_ENDPOINT_LIST_ENV_KEY } from "@artgod/shared/config/rpc-endpoints";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { db, setDbPath } from "@artgod/shared/database";
import { NatsJetStreamQueue } from "../src/infra/queue/nats.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import {
    BACKFILL_ORDER_MAINTENANCE_POLICY,
    BACKFILL_SOURCE,
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

    const timeoutMs = 10_000;

    it("processes a small backfill range", async () => {
        const dbPath = await createTempDbPath();
        setDbPath(dbPath);
        const migrations = createMigrationRunner();
        await migrations.runMigrations();
        seedCollections(config.chainId, config.collections);

        const nats = await startNats(config.natsPort);
        const streamPrefix = `artgod-test-${Date.now()}`;
        const env = {
            ...runtimeEnv,
            ARTGOD_DB_PATH: dbPath,
            NATS_URL: nats.url,
            NATS_STREAM_PREFIX: streamPrefix,
            [RPC_ENDPOINT_LIST_ENV_KEY]: config.rpcEndpoints,
            WETH_ADDRESS: runtimeEnv.WETH_ADDRESS,
            CHAIN_ID: String(config.chainId),
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
                source: BACKFILL_SOURCE.ManualHistorical,
                orderMaintenancePolicy:
                    BACKFILL_ORDER_MAINTENANCE_POLICY.SkipGlobalMakerRevalidation,
            },
            attempt: 0,
            scheduledAt: Date.now(),
            chainId: config.chainId,
        };
        await queue.publish(QUEUE_NAMES.BackfillSync, job);
        await queue.close();

        await waitFor(() => count("blocks") > 0, timeoutMs);
        await waitFor(() => count("nft_transfer_events") > 0, timeoutMs);
        await waitFor(() => count("activities") > 0, timeoutMs);

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

function seedCollections(chainId: number, collectionsJson: string): void {
    const parsed = JSON.parse(collectionsJson) as Array<
        Partial<{
            id: string;
            address: string;
            deploymentBlock: number;
        }>
    >;
    const insert = db.prepare<{
        chainId: number;
        slug: string;
        address: string;
        standard: string;
        status: string;
        tokenScopeKind: string;
        scopeStartTokenId: string | null;
        scopeTotalSupply: number | null;
        deploymentBlock: number | null;
        bootstrapAnchorBlock: number | null;
        bootstrapStartedAt: string | null;
        bootstrapFinishedAt: string | null;
        bootstrapLastSyncedBlock: number | null;
    }>(
        "INSERT INTO collections " +
            "(chain_id, slug, address, standard, status, token_scope_kind, scope_start_token_id, scope_total_supply, deployment_block, bootstrap_anchor_block, " +
            "bootstrap_started_at, bootstrap_finished_at, bootstrap_last_synced_block) " +
            "VALUES (@chainId, @slug, @address, @standard, @status, @tokenScopeKind, @scopeStartTokenId, @scopeTotalSupply, @deploymentBlock, @bootstrapAnchorBlock, " +
            "@bootstrapStartedAt, @bootstrapFinishedAt, @bootstrapLastSyncedBlock) " +
            "ON CONFLICT(chain_id, slug) DO UPDATE SET " +
            "address = excluded.address, standard = excluded.standard, status = excluded.status, " +
            "token_scope_kind = excluded.token_scope_kind, " +
            "scope_start_token_id = excluded.scope_start_token_id, " +
            "scope_total_supply = excluded.scope_total_supply, " +
            "deployment_block = excluded.deployment_block, bootstrap_anchor_block = excluded.bootstrap_anchor_block, " +
            "bootstrap_started_at = excluded.bootstrap_started_at, " +
            "bootstrap_finished_at = excluded.bootstrap_finished_at, " +
            "bootstrap_last_synced_block = excluded.bootstrap_last_synced_block, " +
            "updated_at = CURRENT_TIMESTAMP",
    );
    for (const entry of parsed) {
        if (!entry?.address) continue;
        insert.run({
            chainId,
            slug:
                entry.id ??
                `fixture-${entry.address.toLowerCase().slice(2, 10)}`,
            address: entry.address,
            standard: "erc721",
            status: "live",
            tokenScopeKind: "contract_all_tokens",
            scopeStartTokenId: null,
            scopeTotalSupply: null,
            deploymentBlock: entry.deploymentBlock ?? null,
            bootstrapAnchorBlock: null,
            bootstrapStartedAt: null,
            bootstrapFinishedAt: null,
            bootstrapLastSyncedBlock: null,
        });
    }
}
