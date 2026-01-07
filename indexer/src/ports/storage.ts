import type { OnChainData } from "../domain/onchain.js";
import type { RpcBlock } from "./rpc.js";

export interface StoragePort {
    persistSyncResult(
        chainId: number,
        blocks: RpcBlock[],
        data: OnChainData,
    ): void;
    getBlockHash(chainId: number, blockNumber: number): string | null;
    rollbackFromBlock(chainId: number, fromBlock: number): void;
}
