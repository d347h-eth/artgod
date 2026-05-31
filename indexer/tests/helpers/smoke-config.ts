export type SmokeConfig = {
    rpcEndpoints: string;
    chainId: number;
    collections: string;
    fromBlock: number;
    toBlock: number;
    natsPort: number;
};

export function loadSmokeConfig(
    env: Record<string, string | undefined>,
): SmokeConfig {
    const rpcEndpoints = env.SMOKE_RPC_URL;
    const collections = env.SMOKE_TARGET_COLLECTIONS;
    const fromBlock = parseNumber(env.SMOKE_RANGE_FROM);
    const toBlock = parseNumber(env.SMOKE_RANGE_TO);
    const natsPort = parsePort(env.SMOKE_NATS_PORT);
    if (
        !rpcEndpoints ||
        !collections ||
        fromBlock === null ||
        toBlock === null ||
        natsPort === null
    ) {
        throw new Error(
            "Missing or invalid SMOKE_* configuration (SMOKE_RPC_URL, SMOKE_TARGET_COLLECTIONS, SMOKE_RANGE_FROM, SMOKE_RANGE_TO, SMOKE_NATS_PORT)",
        );
    }
    const chainId = parseNumber(env.SMOKE_CHAIN_ID) ?? 1;
    return {
        rpcEndpoints,
        chainId,
        collections,
        fromBlock,
        toBlock,
        natsPort,
    };
}

function parseNumber(value: string | undefined): number | null {
    if (!value) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return parsed;
}

function parsePort(value: string | undefined): number | null {
    const parsed = parseNumber(value);
    if (parsed === null) return null;
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
        return null;
    }
    return parsed;
}
