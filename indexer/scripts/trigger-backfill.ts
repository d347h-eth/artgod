import { loadConfig } from "../src/config/index.js";
import { buildManualHistoricalBackfillJobs } from "../src/application/manual-backfill-trigger.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import {
    BACKFILL_ORDER_MAINTENANCE_POLICY,
    BACKFILL_SOURCE,
} from "../src/domain/sync-jobs.js";
import { NatsJetStreamQueue } from "../src/infra/queue/nats.js";

type CliArgs = {
    chainId?: number;
    collectionId?: number;
    fromBlock?: number;
    toBlock?: number;
    batchSize?: number;
};

const args = parseArgs(process.argv.slice(2));
if (args.fromBlock === undefined || args.toBlock === undefined) {
    printUsage();
    process.exit(1);
}

const config = loadConfig();
const chainId = args.chainId ?? config.chainId;
const batchSize = args.batchSize ?? config.sync.backfillBatchSize;
const jobs = buildManualHistoricalBackfillJobs({
    chainId,
    collectionId: args.collectionId ?? null,
    fromBlock: args.fromBlock,
    toBlock: args.toBlock,
    batchSize,
    nonce: Date.now(),
});

const queue = await NatsJetStreamQueue.connect({
    natsUrl: config.queue.natsUrl,
    streamPrefix: config.queue.streamPrefix,
});

try {
    // Publish manual historical ranges through the shared queue adapter.
    for (const job of jobs) {
        await queue.publish(QUEUE_NAMES.BackfillSync, job);
    }
} finally {
    await queue.close();
}

const scope = args.collectionId === undefined ? "all" : args.collectionId;
console.log(
    `Queued ${jobs.length} manual historical backfill jobs for chainId=${chainId} collectionId=${scope} range=${args.fromBlock}-${args.toBlock} batchSize=${batchSize} source=${BACKFILL_SOURCE.ManualHistorical} orderMaintenancePolicy=${BACKFILL_ORDER_MAINTENANCE_POLICY.SkipGlobalMakerRevalidation}`,
);

function parseArgs(raw: string[]): CliArgs {
    const parsed: CliArgs = {};
    for (let index = 0; index < raw.length; index += 1) {
        const arg = raw[index];
        if (!arg) continue;
        if (arg === "--chain-id") {
            parsed.chainId = parseIntegerFlag(raw[index + 1], arg);
            index += 1;
            continue;
        }
        if (arg === "--collection-id") {
            parsed.collectionId = parseIntegerFlag(raw[index + 1], arg);
            index += 1;
            continue;
        }
        if (arg === "--from-block") {
            parsed.fromBlock = parseIntegerFlag(raw[index + 1], arg);
            index += 1;
            continue;
        }
        if (arg === "--to-block") {
            parsed.toBlock = parseIntegerFlag(raw[index + 1], arg);
            index += 1;
            continue;
        }
        if (arg === "--batch-size") {
            parsed.batchSize = parseIntegerFlag(raw[index + 1], arg);
            index += 1;
        }
    }
    return parsed;
}

function parseIntegerFlag(raw: string | undefined, flag: string): number {
    const value = Number(raw);
    if (!Number.isInteger(value)) {
        throw new Error(`Invalid ${flag}`);
    }
    return value;
}

function printUsage(): void {
    console.log(
        [
            "Usage: yarn workspace @artgod/indexer run dev:backfill-trigger --from-block <n> --to-block <n> [options]",
            "",
            "Options:",
            "  --chain-id <number>       Chain id (defaults to CHAIN_ID from .env)",
            "  --collection-id <number>  Optional collection_id scope",
            "  --batch-size <number>     Batch size (defaults to BACKFILL_BATCH_SIZE from .env)",
        ].join("\n"),
    );
}
