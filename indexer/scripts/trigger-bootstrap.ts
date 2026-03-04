import { db, setDbPath } from "@artgod/shared/database";
import { loadConfig } from "../src/config/index.js";
import { BOOTSTRAP_JOB_KIND } from "../src/domain/bootstrap-jobs.js";
import type { JobEnvelope } from "../src/domain/jobs.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import { NatsJetStreamQueue } from "../src/infra/queue/nats.js";

type CliArgs = {
    address?: string;
    slug?: string;
    chainId?: number;
    deploymentBlock?: number;
    metadataMode?: "strict" | "best_effort";
};

const args = parseArgs(process.argv.slice(2));
if (!args.address) {
    printUsage();
    process.exit(1);
}

const config = loadConfig();
setDbPath(config.dbPath);
const chainId = args.chainId ?? config.chainId;
const address = normalizeAddress(args.address);
const slug = (args.slug?.trim().toLowerCase() || address).slice(0, 80);
const metadataMode = args.metadataMode ?? "best_effort";
const deploymentBlock = args.deploymentBlock ?? null;

const collection = upsertCollection({
    chainId,
    slug,
    address,
    deploymentBlock,
});
const run = createRun({
    chainId,
    collectionId: collection.collectionId,
    slug,
    address,
    metadataMode,
    deploymentBlock,
});

const payload = {
    chainId,
    runId: run.runId,
    collectionId: collection.collectionId,
};
const job: JobEnvelope<typeof payload> = {
    jobId: `bootstrap:start:${chainId}:${run.runId}:${Date.now()}`,
    kind: BOOTSTRAP_JOB_KIND.Start,
    queue: QUEUE_NAMES.CollectionBootstrap,
    payload,
    attempt: 0,
    scheduledAt: Date.now(),
    chainId,
    collectionId: collection.collectionId,
};

const queue = await NatsJetStreamQueue.connect({
    natsUrl: config.queue.natsUrl,
    streamPrefix: config.queue.streamPrefix,
});
await queue.publish(QUEUE_NAMES.CollectionBootstrap, job);
await queue.close();

console.log(
    `Queued bootstrap run: chainId=${chainId} collectionId=${collection.collectionId} runId=${run.runId} address=${address} slug=${slug} metadataMode=${metadataMode}`,
);

function upsertCollection(input: {
    chainId: number;
    slug: string;
    address: string;
    deploymentBlock: number | null;
}): { collectionId: number } {
    db.prepare(
        "INSERT INTO collections " +
            "(chain_id, slug, address, standard, status, deployment_block, bootstrap_anchor_block, bootstrap_started_at, bootstrap_finished_at, bootstrap_last_synced_block) " +
            "VALUES (?, ?, ?, 'erc721', 'bootstrapping', ?, NULL, NULL, NULL, NULL) " +
            "ON CONFLICT(chain_id, address) DO UPDATE SET " +
            "slug = excluded.slug, status = 'bootstrapping', deployment_block = COALESCE(excluded.deployment_block, collections.deployment_block), updated_at = CURRENT_TIMESTAMP",
    ).run(input.chainId, input.slug, input.address, input.deploymentBlock);

    const row = db
        .prepare(
            "SELECT collection_id FROM collections WHERE chain_id = ? AND address = ? LIMIT 1",
        )
        .get(input.chainId, input.address) as
        | { collection_id: number }
        | undefined;
    if (!row) {
        throw new Error("collection upsert failed");
    }
    return { collectionId: row.collection_id };
}

function createRun(input: {
    chainId: number;
    collectionId: number;
    slug: string;
    address: string;
    metadataMode: "strict" | "best_effort";
    deploymentBlock: number | null;
}): { runId: number } {
    db.prepare(
        "INSERT INTO bootstrap_runs " +
            "(chain_id, collection_id, request_slug, request_address, request_standard, metadata_mode, enumeration_mode, manual_token_ids_json, manual_range_start_token_id, manual_range_total_supply, deployment_block, status) " +
            "VALUES (?, ?, ?, ?, 'erc721', ?, 'enumerable', NULL, NULL, NULL, ?, 'requested')",
    ).run(
        input.chainId,
        input.collectionId,
        input.slug,
        input.address,
        input.metadataMode,
        input.deploymentBlock,
    );
    const row = db
        .prepare(
            "SELECT run_id FROM bootstrap_runs WHERE chain_id = ? AND collection_id = ? ORDER BY run_id DESC LIMIT 1",
        )
        .get(input.chainId, input.collectionId) as
        | { run_id: number }
        | undefined;
    if (!row) {
        throw new Error("bootstrap run insert failed");
    }
    db.prepare(
        "INSERT INTO bootstrap_run_events " +
            "(run_id, chain_id, collection_id, event_code, event_level, message, payload_json) " +
            "VALUES (?, ?, ?, 'run.requested', 'info', 'Bootstrap run requested via script', NULL)",
    ).run(row.run_id, input.chainId, input.collectionId);
    return { runId: row.run_id };
}

function normalizeAddress(raw: string): string {
    const value = raw.trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(value)) {
        throw new Error("Invalid --address");
    }
    return value;
}

function parseArgs(raw: string[]): CliArgs {
    const parsed: CliArgs = {};
    for (let i = 0; i < raw.length; i += 1) {
        const arg = raw[i];
        if (!arg) continue;
        if (arg === "--address") {
            parsed.address = raw[i + 1];
            i += 1;
            continue;
        }
        if (arg === "--slug") {
            parsed.slug = raw[i + 1];
            i += 1;
            continue;
        }
        if (arg === "--chain-id") {
            const value = Number(raw[i + 1]);
            parsed.chainId = Number.isFinite(value) ? value : undefined;
            i += 1;
            continue;
        }
        if (arg === "--deployment-block") {
            const value = Number(raw[i + 1]);
            parsed.deploymentBlock = Number.isFinite(value) ? value : undefined;
            i += 1;
            continue;
        }
        if (arg === "--metadata-mode") {
            const value = raw[i + 1];
            if (value === "strict" || value === "best_effort") {
                parsed.metadataMode = value;
            }
            i += 1;
            continue;
        }
    }
    return parsed;
}

function printUsage(): void {
    console.log(
        [
            "Usage: yarn workspace @artgod/indexer dev:bootstrap-trigger --address <0x...> [options]",
            "",
            "Options:",
            "  --slug <slug>               Slug (defaults to address)",
            "  --chain-id <number>         Chain id (defaults to CHAIN_ID from .env)",
            "  --deployment-block <number> Deployment block (optional)",
            "  --metadata-mode <strict|best_effort> Metadata snapshot completion mode (defaults to best_effort)",
        ].join("\n"),
    );
}
