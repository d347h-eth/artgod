import { createPublicClient, http } from "viem";
import { getEnsAddress } from "viem/actions";
import { normalize } from "viem/ens";
import type { RpcEndpointConfig } from "@artgod/shared/config/rpc-endpoints";
import { WeightedEndpointSelector } from "@artgod/shared/config/weighted-endpoints";
import { NOOP_APM, type ApmPort } from "@artgod/shared/observability/apm";
import type { Metrics } from "@artgod/shared/observability/metrics";
import { RpcObservability } from "@artgod/shared/observability/rpc";

export type BackendRpcHex = `0x${string}`;

const ENS_UNIVERSAL_RESOLVER_ADDRESS =
    "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe";

// Names generic backend RPC attributes without exposing high-cardinality payload data.
const BACKEND_RPC_SPAN_ATTRIBUTE = {
    BlockNumber: "artgod.rpc.block_number",
    ContractAddress: "artgod.rpc.contract_address",
    FunctionName: "artgod.rpc.function_name",
    EnsNamePresent: "artgod.rpc.ens_name_present",
    StorageSlotPresent: "artgod.rpc.storage_slot_present",
    CacheHit: "artgod.rpc.cache_hit",
    Endpoint: "artgod.rpc.endpoint",
} as const;

const CURRENT_BLOCK_NUMBER_CACHE_TTL_MS = 2_000;
type BackendViemClient = ReturnType<typeof createPublicClient>;

export class ViemBackendRpcClient {
    private readonly endpointSelector: WeightedEndpointSelector<BackendViemClient>;
    private readonly rpcObservability: RpcObservability;
    private currentBlockNumberCache: {
        blockNumber: number;
        expiresAtMs: number;
    } | null = null;
    private readonly blockTimestampCache = new Map<number, number>();

    constructor(
        endpoints: readonly RpcEndpointConfig[],
        private readonly apm: ApmPort = NOOP_APM,
        metrics?: Metrics,
    ) {
        this.endpointSelector = new WeightedEndpointSelector(
            endpoints.map((endpoint, index) => ({
                ...endpoint,
                id: `backend-rpc-${index + 1}`,
                value: createPublicClient({
                    transport: http(endpoint.url),
                }),
            })),
        );
        this.rpcObservability = new RpcObservability({
            workspace: "backend",
            component: "backend-rpc",
            protocol: "http",
            metrics,
            logComponent: "BackendRpc",
        });
        for (const endpoint of this.endpointSelector.snapshot()) {
            this.rpcObservability.recordConfiguredEndpoint(endpoint);
        }
    }

    async resolveEnsAddress(name: string): Promise<string | null> {
        return this.withRpcSpan(
            "backend.rpc.resolve_ens_address",
            {
                [BACKEND_RPC_SPAN_ATTRIBUTE.EnsNamePresent]:
                    name.trim().length > 0,
            },
            async (client) => {
                const normalizedName = normalize(name.trim());
                const resolvedAddress = await getEnsAddress(client, {
                    name: normalizedName,
                    universalResolverAddress: ENS_UNIVERSAL_RESOLVER_ADDRESS,
                });
                if (!resolvedAddress) {
                    return null;
                }
                return resolvedAddress.toLowerCase();
            },
        );
    }

    async getCurrentBlockNumber(): Promise<number> {
        const now = Date.now();
        const cached = this.currentBlockNumberCache;
        const cacheHit = cached !== null && cached.expiresAtMs > now;
        if (cached !== null && cacheHit) {
            return this.apm.withSpan(
                "backend.rpc.current_block_number",
                {
                    [BACKEND_RPC_SPAN_ATTRIBUTE.CacheHit]: true,
                },
                async () => {
                    return cached.blockNumber;
                },
            );
        }
        return this.withRpcSpan(
            "backend.rpc.current_block_number",
            {
                [BACKEND_RPC_SPAN_ATTRIBUTE.CacheHit]: false,
            },
            async (client) => {
                const blockNumber = await client.getBlockNumber();
                const parsedBlockNumber = Number(blockNumber);
                this.currentBlockNumberCache = {
                    blockNumber: parsedBlockNumber,
                    expiresAtMs: Date.now() + CURRENT_BLOCK_NUMBER_CACHE_TTL_MS,
                };
                return parsedBlockNumber;
            },
        );
    }

    async getBlockTimestamp(blockNumber: number): Promise<number> {
        const cachedTimestamp = this.blockTimestampCache.get(blockNumber);
        if (cachedTimestamp !== undefined) {
            return this.apm.withSpan(
                "backend.rpc.block_timestamp",
                {
                    [BACKEND_RPC_SPAN_ATTRIBUTE.BlockNumber]: blockNumber,
                    [BACKEND_RPC_SPAN_ATTRIBUTE.CacheHit]: true,
                },
                async () => {
                    return cachedTimestamp;
                },
            );
        }
        return this.withRpcSpan(
            "backend.rpc.block_timestamp",
            {
                [BACKEND_RPC_SPAN_ATTRIBUTE.BlockNumber]: blockNumber,
                [BACKEND_RPC_SPAN_ATTRIBUTE.CacheHit]: false,
            },
            async (client) => {
                const block = await client.getBlock({
                    blockNumber: BigInt(blockNumber),
                });
                const timestamp = Number(block.timestamp);
                if (Number.isInteger(timestamp) && timestamp >= 0) {
                    this.blockTimestampCache.set(blockNumber, timestamp);
                }
                return timestamp;
            },
        );
    }

    async readContract<T = unknown>(params: {
        address: BackendRpcHex;
        abi: readonly unknown[];
        functionName: string;
        args?: readonly unknown[];
        blockNumber?: number;
    }): Promise<T> {
        return this.withRpcSpan(
            "backend.rpc.read_contract",
            {
                [BACKEND_RPC_SPAN_ATTRIBUTE.ContractAddress]: params.address,
                [BACKEND_RPC_SPAN_ATTRIBUTE.FunctionName]: params.functionName,
                ...(params.blockNumber !== undefined
                    ? {
                          [BACKEND_RPC_SPAN_ATTRIBUTE.BlockNumber]:
                              params.blockNumber,
                      }
                    : {}),
            },
            async (client) => {
                const result = await client.readContract({
                    address: params.address,
                    abi: params.abi as any,
                    functionName: params.functionName as any,
                    args: params.args as any,
                    blockNumber:
                        params.blockNumber !== undefined
                            ? BigInt(params.blockNumber)
                            : undefined,
                });
                return result as T;
            },
        );
    }

    async getStorageAt(params: {
        address: BackendRpcHex;
        slot: BackendRpcHex;
        blockNumber?: number;
    }): Promise<BackendRpcHex | null> {
        return this.withRpcSpan(
            "backend.rpc.get_storage_at",
            {
                [BACKEND_RPC_SPAN_ATTRIBUTE.ContractAddress]: params.address,
                [BACKEND_RPC_SPAN_ATTRIBUTE.StorageSlotPresent]:
                    params.slot.length > 0,
                ...(params.blockNumber !== undefined
                    ? {
                          [BACKEND_RPC_SPAN_ATTRIBUTE.BlockNumber]:
                              params.blockNumber,
                      }
                    : {}),
            },
            async (client) => {
                const value = await client.getStorageAt({
                    address: params.address,
                    slot: params.slot,
                    blockNumber:
                        params.blockNumber !== undefined
                            ? BigInt(params.blockNumber)
                            : undefined,
                });
                return (value ?? null) as BackendRpcHex | null;
            },
        );
    }

    private async withRpcSpan<T>(
        name: string,
        attributes: Record<string, unknown>,
        read: (client: BackendViemClient) => Promise<T>,
    ): Promise<T> {
        const endpoint = this.endpointSelector.select();
        const method = backendRpcMethodLabel(name);
        const call = this.rpcObservability.startCall(method);
        const attempt = this.rpcObservability.startEndpointAttempt(
            call,
            endpoint,
            1,
        );
        return this.apm.withSpan(
            name,
            {
                ...attributes,
                [BACKEND_RPC_SPAN_ATTRIBUTE.Endpoint]: endpoint.id,
            },
            async () => {
                try {
                    const result = await read(endpoint.value);
                    const updatedEndpoint =
                        this.endpointSelector.recordSuccess(endpoint.id) ??
                        endpoint;
                    this.rpcObservability.recordEndpointAttemptSuccess(
                        attempt,
                        updatedEndpoint,
                    );
                    this.rpcObservability.recordCallSuccess(
                        call,
                        updatedEndpoint,
                    );
                    return result;
                } catch (error) {
                    const updatedEndpoint =
                        this.endpointSelector.recordFailure(endpoint.id) ??
                        endpoint;
                    this.rpcObservability.recordEndpointAttemptFailure(
                        attempt,
                        updatedEndpoint,
                        error,
                    );
                    this.rpcObservability.recordCallFailure(
                        call,
                        updatedEndpoint,
                        error,
                    );
                    throw error;
                }
            },
        );
    }
}

function backendRpcMethodLabel(spanName: string): string {
    return spanName.replace(/^backend\.rpc\./, "");
}
