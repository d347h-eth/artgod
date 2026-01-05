import dotenv from "dotenv";
import { resolveProjectPath } from "@artgod/shared/utils";

dotenv.config({ path: resolveProjectPath(".env") });

export type CollectionConfig = {
    id: string;
    address: string;
    deploymentBlock: number;
};

export type IndexerConfig = {
    chainId: number;
    rpc: {
        primaryUrl: string;
        backfillUrl?: string;
        wsUrl?: string;
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
    collections: CollectionConfig[];
};

function parseNumber(
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

function parseCollections(value: string | undefined): CollectionConfig[] {
    if (!value) return [];
    let data: unknown;
    try {
        data = JSON.parse(value);
    } catch (err) {
        throw new Error(`Invalid TARGET_COLLECTIONS JSON: ${String(err)}`);
    }
    if (!Array.isArray(data)) {
        throw new Error("TARGET_COLLECTIONS must be a JSON array");
    }
    return data.map((item, index) => {
        if (!item || typeof item !== "object") {
            throw new Error(`TARGET_COLLECTIONS[${index}] is not an object`);
        }
        const record = item as Record<string, unknown>;
        const address = String(record.address ?? "");
        if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
            throw new Error(`Invalid collection address: ${address}`);
        }
        const id = String(record.id ?? address);
        const deploymentBlock = parseNumber(
            record.deploymentBlock !== undefined
                ? String(record.deploymentBlock)
                : "0",
            `TARGET_COLLECTIONS[${index}].deploymentBlock`,
            0,
        );
        return { id, address, deploymentBlock };
    });
}

export function loadConfig(
    env: Record<string, string | undefined> = process.env,
): IndexerConfig {
    const chainId = parseNumber(env.CHAIN_ID, "CHAIN_ID", 1);
    const rpcUrl = env.RPC_URL;
    if (!rpcUrl) {
        throw new Error("Missing RPC_URL");
    }
    const collections = parseCollections(env.TARGET_COLLECTIONS);

    return {
        chainId,
        rpc: {
            primaryUrl: rpcUrl,
            backfillUrl: env.RPC_BACKFILL_URL,
            wsUrl: env.RPC_WS_URL,
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
        collections,
    };
}
