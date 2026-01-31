import { loadConfig } from "../src/config/index.js";
import { NatsJetStreamQueue } from "../src/infra/queue/nats.js";
import { SqliteCollectionRegistry } from "../src/infra/collections/sqlite.js";
import {
    BOOTSTRAP_JOB_KIND,
    type BootstrapCollectionPayload,
} from "../src/domain/bootstrap-jobs.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import type { JobEnvelope } from "../src/domain/jobs.js";

type CliArgs = {
    address?: string;
    collectionId?: string;
    chainId?: number;
    deploymentBlock?: number;
};

const args = parseArgs(process.argv.slice(2));
if (!args.address) {
    printUsage();
    process.exit(1);
}

const config = loadConfig();
const chainId = args.chainId ?? config.chainId;
const address = args.address;
const collectionId = args.collectionId ?? address;
const standard = "erc721";
const deploymentBlock = args.deploymentBlock ?? null;

const registry = new SqliteCollectionRegistry();
registry.upsertCollection({
    chainId,
    id: collectionId,
    address,
    standard,
    status: "bootstrapping",
    deploymentBlock,
    bootstrapAnchorBlock: null,
    bootstrapStartedAt: null,
    bootstrapFinishedAt: null,
    bootstrapLastSyncedBlock: null,
});

const payload: BootstrapCollectionPayload = {
    chainId,
    collectionId,
    address,
    standard,
};

const job: JobEnvelope<BootstrapCollectionPayload> = {
    jobId: `bootstrap:start:${chainId}:${collectionId}:${Date.now()}`,
    kind: BOOTSTRAP_JOB_KIND.Start,
    queue: QUEUE_NAMES.CollectionBootstrap,
    payload,
    attempt: 0,
    scheduledAt: Date.now(),
    chainId,
    collectionId,
};

const queue = await NatsJetStreamQueue.connect({
    natsUrl: config.queue.natsUrl,
    streamPrefix: config.queue.streamPrefix,
});
await queue.publish(QUEUE_NAMES.CollectionBootstrap, job);
await queue.close();

console.log(
    `Upserted + queued bootstrap: chainId=${chainId} collectionId=${collectionId} address=${address} standard=${standard}`,
);

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
        if (arg === "--collection-id") {
            parsed.collectionId = raw[i + 1];
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
    }
    return parsed;
}

function printUsage(): void {
    console.log(
        [
            "Usage: yarn workspace @artgod/indexer dev:bootstrap-trigger --address <0x...> [options]",
            "",
            "Options:",
            "  --collection-id <id>   Collection id (defaults to address)",
            "  --chain-id <number>     Chain id (defaults to CHAIN_ID from .env)",
            "  --deployment-block <number> Deployment block (optional)",
        ].join("\n"),
    );
}
