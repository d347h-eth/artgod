import { createPublicClient, http } from "viem";
import { getEnsAddress } from "viem/actions";
import { normalize } from "viem/ens";

export type BackendRpcHex = `0x${string}`;

const ENS_UNIVERSAL_RESOLVER_ADDRESS =
    "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe";

export class ViemBackendRpcClient {
    private readonly client;

    constructor(rpcUrl: string) {
        this.client = createPublicClient({
            transport: http(rpcUrl),
        });
    }

    async resolveEnsAddress(name: string): Promise<string | null> {
        const normalizedName = normalize(name.trim());
        const resolvedAddress = await getEnsAddress(this.client, {
            name: normalizedName,
            universalResolverAddress: ENS_UNIVERSAL_RESOLVER_ADDRESS,
        });
        if (!resolvedAddress) {
            return null;
        }
        return resolvedAddress.toLowerCase();
    }

    async getCurrentBlockNumber(): Promise<number> {
        const blockNumber = await this.client.getBlockNumber();
        return Number(blockNumber);
    }

    async readContract<T = unknown>(params: {
        address: BackendRpcHex;
        abi: readonly unknown[];
        functionName: string;
        args?: readonly unknown[];
        blockNumber?: number;
    }): Promise<T> {
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
    }

    async getStorageAt(params: {
        address: BackendRpcHex;
        slot: BackendRpcHex;
        blockNumber?: number;
    }): Promise<BackendRpcHex | null> {
        const value = await this.client.getStorageAt({
            address: params.address,
            slot: params.slot,
            blockNumber:
                params.blockNumber !== undefined
                    ? BigInt(params.blockNumber)
                    : undefined,
        });
        return (value ?? null) as BackendRpcHex | null;
    }
}
