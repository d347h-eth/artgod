import { db, setDbPath } from "@artgod/shared/database";
import {
    EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND,
    type CollectionExtensionKey,
} from "@artgod/shared/extensions";
import { resolveEmbeddedCollectionExtensionInstall } from "@artgod/shared/extensions/built-ins";
import { loadConfig } from "../src/config/index.js";
import { BOOTSTRAP_JOB_KIND } from "../src/domain/bootstrap-jobs.js";
import type { JobEnvelope } from "../src/domain/jobs.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import { NatsJetStreamQueue } from "../src/infra/queue/nats.js";

type CliArgs = {
    address?: string;
    slug?: string;
    openseaSlug?: string;
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
const openseaSlug = normalizeOptionalSlug(args.openseaSlug);
if (openseaSlug && !config.integrations.opensea.enabled) {
    throw new Error(
        `--opensea-slug requires OpenSea integration to be enabled: ${config.integrations.opensea.reason ?? "disabled"}`,
    );
}
const metadataMode = args.metadataMode ?? "best_effort";
const deploymentBlock = args.deploymentBlock ?? null;
const requestExtensionKey = resolveRequestExtensionKey({
    chainId,
    address,
});

const collection = upsertCollection({
    chainId,
    slug,
    address,
    openseaSlug,
    deploymentBlock,
});
const run = createRun({
    chainId,
    collectionId: collection.collectionId,
    slug,
    openseaSlug,
    address,
    requestExtensionKey,
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
markRunQueued({
    runId: run.runId,
    chainId,
    collectionId: collection.collectionId,
});
await queue.close();

console.log(
    `Queued bootstrap run: chainId=${chainId} collectionId=${collection.collectionId} runId=${run.runId} address=${address} slug=${slug} openseaSlug=${openseaSlug ?? "none"} requestExtensionKey=${requestExtensionKey ?? "none"} metadataMode=${metadataMode}`,
);

function upsertCollection(input: {
    chainId: number;
    slug: string;
    address: string;
    openseaSlug: string | null;
    deploymentBlock: number | null;
}): { collectionId: number } {
    db.prepare(
        "INSERT INTO collections " +
            "(chain_id, slug, address, standard, status, token_scope_kind, scope_start_token_id, scope_total_supply, deployment_block, bootstrap_anchor_block, bootstrap_started_at, bootstrap_finished_at, bootstrap_last_synced_block, opensea_slug) " +
            "VALUES (?, ?, ?, 'erc721', 'bootstrapping', 'contract_all_tokens', NULL, NULL, ?, NULL, NULL, NULL, NULL, ?) " +
            "ON CONFLICT(chain_id, slug) DO UPDATE SET " +
            "address = excluded.address, status = 'bootstrapping', deployment_block = COALESCE(excluded.deployment_block, collections.deployment_block), opensea_slug = COALESCE(excluded.opensea_slug, collections.opensea_slug), updated_at = CURRENT_TIMESTAMP",
    ).run(
        input.chainId,
        input.slug,
        input.address,
        input.deploymentBlock,
        input.openseaSlug,
    );

    const row = db
        .prepare(
            "SELECT collection_id FROM collections WHERE chain_id = ? AND slug = ? LIMIT 1",
        )
        .get(input.chainId, input.slug) as
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
    openseaSlug: string | null;
    address: string;
    requestExtensionKey: CollectionExtensionKey | null;
    metadataMode: "strict" | "best_effort";
    deploymentBlock: number | null;
}): { runId: number } {
    db.prepare(
        "INSERT INTO bootstrap_runs " +
            "(chain_id, collection_id, request_slug, request_opensea_slug, request_address, request_standard, request_extension_key, metadata_mode, enumeration_mode, manual_token_ids_json, manual_range_start_token_id, manual_range_total_supply, deployment_block, status) " +
            "VALUES (?, ?, ?, ?, ?, 'erc721', ?, ?, 'enumerable', NULL, NULL, NULL, ?, 'requested')",
    ).run(
        input.chainId,
        input.collectionId,
        input.slug,
        input.openseaSlug,
        input.address,
        input.requestExtensionKey,
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

function markRunQueued(input: {
    runId: number;
    chainId: number;
    collectionId: number;
}): void {
    db.prepare(
        "UPDATE bootstrap_runs SET status = 'queued', updated_at = CURRENT_TIMESTAMP WHERE run_id = ?",
    ).run(input.runId);
    db.prepare(
        "INSERT INTO bootstrap_run_events " +
            "(run_id, chain_id, collection_id, event_code, event_level, message, payload_json) " +
            "VALUES (?, ?, ?, 'run.queued', 'info', 'Bootstrap run queued via script', NULL)",
    ).run(input.runId, input.chainId, input.collectionId);
}

function normalizeAddress(raw: string): string {
    const value = raw.trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(value)) {
        throw new Error("Invalid --address");
    }
    return value;
}

function normalizeOptionalSlug(raw: string | undefined): string | null {
    if (raw === undefined) {
        return null;
    }
    const value = raw.trim().toLowerCase();
    if (!value) {
        return null;
    }
    if (!/^[a-z0-9-]+$/.test(value)) {
        throw new Error("Invalid --opensea-slug");
    }
    if (value.length > 80) {
        throw new Error("--opensea-slug is too long");
    }
    return value;
}

function resolveRequestExtensionKey(input: {
    chainId: number;
    address: string;
}): CollectionExtensionKey | null {
    // Mirror the backend bootstrap use case for the script's enumerable all-token scope.
    const install = resolveEmbeddedCollectionExtensionInstall({
        chainId: input.chainId,
        contractAddress: input.address,
        scope: {
            kind: EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.AllContractTokens,
        },
    });
    return install?.extensionKey ?? null;
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
        if (arg === "--opensea-slug") {
            parsed.openseaSlug = raw[i + 1];
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
            "  --opensea-slug <slug>       Optional OpenSea collection slug for orderbook bootstrap",
            "  --chain-id <number>         Chain id (defaults to CHAIN_ID from .env)",
            "  --deployment-block <number> Deployment block (optional)",
            "  --metadata-mode <strict|best_effort> Metadata snapshot completion mode (defaults to best_effort)",
        ].join("\n"),
    );
}
