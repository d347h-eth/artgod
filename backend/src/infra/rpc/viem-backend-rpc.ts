import { createPublicClient, http } from "viem";
import { getEnsAddress } from "viem/actions";
import { normalize } from "viem/ens";
import {
    NOOP_APM,
    type ApmPort,
} from "@artgod/shared/observability/apm";

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
} as const;

export class ViemBackendRpcClient {
    private readonly client;

    constructor(rpcUrl: string, private readonly apm: ApmPort = NOOP_APM) {
        this.client = createPublicClient({
            transport: http(rpcUrl),
        });
    }

    async resolveEnsAddress(name: string): Promise<string | null> {
        return this.apm.withSpan(
            "backend.rpc.resolve_ens_address",
            {
                [BACKEND_RPC_SPAN_ATTRIBUTE.EnsNamePresent]:
                    name.trim().length > 0,
            },
            async () => {
                const normalizedName = normalize(name.trim());
                const resolvedAddress = await getEnsAddress(this.client, {
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
        return this.apm.withSpan(
            "backend.rpc.current_block_number",
            {},
            async () => {
                const blockNumber = await this.client.getBlockNumber();
                return Number(blockNumber);
            },
        );
    }

    async getBlockTimestamp(blockNumber: number): Promise<number> {
        return this.apm.withSpan(
            "backend.rpc.block_timestamp",
            {
                [BACKEND_RPC_SPAN_ATTRIBUTE.BlockNumber]: blockNumber,
            },
            async () => {
                const block = await this.client.getBlock({
                    blockNumber: BigInt(blockNumber),
                });
                return Number(block.timestamp);
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
        return this.apm.withSpan(
            "backend.rpc.read_contract",
            {
                [BACKEND_RPC_SPAN_ATTRIBUTE.ContractAddress]: params.address,
                [BACKEND_RPC_SPAN_ATTRIBUTE.FunctionName]:
                    params.functionName,
                ...(params.blockNumber !== undefined
                    ? {
                          [BACKEND_RPC_SPAN_ATTRIBUTE.BlockNumber]:
                              params.blockNumber,
                      }
                    : {}),
            },
            async () => {
                const result = await this.client.readContract({
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
        return this.apm.withSpan(
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
            async () => {
                const value = await this.client.getStorageAt({
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
}
