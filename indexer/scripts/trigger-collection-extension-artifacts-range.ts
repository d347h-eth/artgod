import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config/index.js";
import { NatsJetStreamQueue } from "../src/infra/queue/nats.js";
import { publishCollectionExtensionRefreshArtifacts } from "../src/application/collection-extensions/jobs.js";

type CliArgs = {
    collectionId?: number;
    contract?: string;
    fromTokenId?: string;
    toTokenId?: string;
    chainId?: number;
    reason?: string;
    source?: string;
};

const args = parseArgs(process.argv.slice(2));
if (
    !args.collectionId ||
    !args.contract ||
    !args.fromTokenId ||
    !args.toTokenId
) {
    printUsage();
    process.exit(1);
}

const config = loadConfig();
const chainId = args.chainId ?? config.chainId;
const contract = normalizeAddress(args.contract);
const fromTokenId = normalizeTokenId(args.fromTokenId, "--from-token-id");
const toTokenId = normalizeTokenId(args.toTokenId, "--to-token-id");
const reason = normalizeReason(args.reason);
const source = normalizeSource(args.source);

if (fromTokenId > toTokenId) {
    throw new Error("--from-token-id must be <= --to-token-id");
}

const queue = await NatsJetStreamQueue.connect({
    natsUrl: config.queue.natsUrl,
    streamPrefix: config.queue.streamPrefix,
});

let published = 0;
for (let tokenId = fromTokenId; tokenId <= toTokenId; tokenId += 1n) {
    await publishCollectionExtensionRefreshArtifacts(
        queue,
        {
            chainId,
            collectionId: args.collectionId,
            contract,
            tokenId: tokenId.toString(),
            reason,
            source,
        },
        randomUUID(),
    );
    published += 1;
}

await queue.close();

console.log(
    `Queued ${published} collection-extension.refresh-artifacts jobs for collectionId=${args.collectionId} contract=${contract} tokenRange=${fromTokenId.toString()}-${toTokenId.toString()} reason=${reason}`,
);

function normalizeAddress(raw: string): string {
    const value = raw.trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(value)) {
        throw new Error("Invalid --contract");
    }
    return value;
}

function normalizeTokenId(raw: string, flag: string): bigint {
    const value = raw.trim();
    if (!/^\d+$/.test(value)) {
        throw new Error(`Invalid ${flag}`);
    }
    return BigInt(value);
}

function normalizeReason(raw: string | undefined): string {
    const value = raw?.trim();
    return value && value.length > 0 ? value : "manual-refresh";
}

function normalizeSource(raw: string | undefined): string {
    const value = raw?.trim();
    return value && value.length > 0 ? value : "manual";
}

function parseArgs(raw: string[]): CliArgs {
    const parsed: CliArgs = {};
    for (let index = 0; index < raw.length; index += 1) {
        const arg = raw[index];
        if (!arg) {
            continue;
        }
        if (arg === "--collection-id") {
            const value = Number(raw[index + 1]);
            parsed.collectionId = Number.isInteger(value) ? value : undefined;
            index += 1;
            continue;
        }
        if (arg === "--contract") {
            parsed.contract = raw[index + 1];
            index += 1;
            continue;
        }
        if (arg === "--from-token-id") {
            parsed.fromTokenId = raw[index + 1];
            index += 1;
            continue;
        }
        if (arg === "--to-token-id") {
            parsed.toTokenId = raw[index + 1];
            index += 1;
            continue;
        }
        if (arg === "--chain-id") {
            const value = Number(raw[index + 1]);
            parsed.chainId = Number.isInteger(value) ? value : undefined;
            index += 1;
            continue;
        }
        if (arg === "--reason") {
            parsed.reason = raw[index + 1];
            index += 1;
            continue;
        }
        if (arg === "--source") {
            parsed.source = raw[index + 1];
            index += 1;
        }
    }
    return parsed;
}

function printUsage(): void {
    console.log(
        [
            "Usage: yarn workspace @artgod/indexer dev:collection-extension-trigger-range --collection-id <id> --contract <0x...> --from-token-id <n> --to-token-id <n> [options]",
            "",
            "Options:",
            "  --chain-id <number>         Chain id (defaults to CHAIN_ID from .env)",
            "  --reason <text>             Job reason (defaults to manual-refresh)",
            "  --source <text>             Job source (defaults to manual)",
        ].join("\n"),
    );
}
