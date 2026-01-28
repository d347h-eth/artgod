import dotenv from "dotenv";
import { resolveProjectPath } from "@artgod/shared/utils";

dotenv.config({ path: resolveProjectPath(".env") });

export type IndexerConfig = {
    chainId: number;
    rpc: {
        primaryUrl: string;
        backfillUrl?: string;
        wsUrl?: string;
    };
    tokens: {
        wethAddress: string;
    };
    queue: {
        natsUrl: string;
        streamPrefix: string;
    };
    sync: {
        reorgDepth: number;
        backfillBatchSize: number;
        logChunkSize: number;
    };
    cache: {
        maxEntries: number;
        ttlMs: number;
    };
};

export function parseNumber(
    value: string | undefined,
    name: string,
    defaultValue?: number,
): number {
    if (value === undefined || value === "") {
        if (defaultValue !== undefined) return defaultValue;
        throw new Error(`Missing ${name}`);
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid ${name}: ${value}`);
    }
    return parsed;
}

export function parseRequiredString(
    value: string | undefined,
    name: string,
): string {
    if (!value) {
        throw new Error(`Missing ${name}`);
    }
    return value;
}

function parseAddress(value: string | undefined, name: string): string {
    if (!value) {
        throw new Error(`Missing ${name}`);
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
        throw new Error(`Invalid ${name}: ${value}`);
    }
    return value;
}

export function loadConfig(
    env: Record<string, string | undefined> = process.env,
): IndexerConfig {
    const chainId = parseNumber(env.CHAIN_ID, "CHAIN_ID", 1);
    const rpcUrl = env.RPC_URL;
    if (!rpcUrl) {
        throw new Error("Missing RPC_URL");
    }

    return {
        chainId,
        rpc: {
            primaryUrl: rpcUrl,
            backfillUrl: env.RPC_BACKFILL_URL,
            wsUrl: env.RPC_WS_URL,
        },
        tokens: {
            wethAddress: parseAddress(env.WETH_ADDRESS, "WETH_ADDRESS"),
        },
        queue: {
            natsUrl: env.NATS_URL ?? "nats://127.0.0.1:4222",
            streamPrefix: env.NATS_STREAM_PREFIX ?? "artgod",
        },
        sync: {
            reorgDepth: parseNumber(env.REORG_DEPTH, "REORG_DEPTH", 20),
            backfillBatchSize: parseNumber(
                env.BACKFILL_BATCH_SIZE,
                "BACKFILL_BATCH_SIZE",
                50,
            ),
            logChunkSize: parseNumber(
                env.LOG_CHUNK_SIZE,
                "LOG_CHUNK_SIZE",
                2000,
            ),
        },
        cache: {
            maxEntries: parseNumber(
                env.CACHE_MAX_ENTRIES,
                "CACHE_MAX_ENTRIES",
                5000,
            ),
            ttlMs: parseNumber(env.CACHE_TTL_MS, "CACHE_TTL_MS", 30_000),
        },
    };
}
