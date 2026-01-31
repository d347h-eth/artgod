import type { OnChainData } from "../domain/onchain.js";
import type { RpcBlock } from "./rpc.js";

export interface StoragePort {
    persistSyncResult(
        chainId: number,
        blocks: RpcBlock[],
        data: OnChainData,
    ): void;
    getBlockHash(chainId: number, blockNumber: number): string | null;
    countBlocksInRange(
        chainId: number,
        fromBlock: number,
        toBlock: number,
    ): number;
    rollbackFromBlock(chainId: number, fromBlock: number): void;
}
