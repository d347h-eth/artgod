import type { OnChainData } from "../domain/onchain.js";
import type { CollectionRecord } from "../domain/collections.js";
import type { RpcBlock } from "./rpc.js";
import type { ChainSyncCheckpoint } from "../domain/chain-sync.js";

export interface StoragePort {
    captureSyncCheckpoint(chainId: number): ChainSyncCheckpoint;
    persistSyncResult(input: {
        checkpoint: ChainSyncCheckpoint;
        blocks: RpcBlock[];
        data: OnChainData;
        collections: CollectionRecord[];
    }): void;
    getBlockHash(chainId: number, blockNumber: number): string | null;
    countBlocksInRange(
        chainId: number,
        fromBlock: number,
        toBlock: number,
    ): number;
    countCollectionSyncedBlocksInRange(
        chainId: number,
        collectionId: number,
        fromBlock: number,
        toBlock: number,
    ): number;
}
