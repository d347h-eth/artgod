import type { OnChainData } from "../domain/onchain.js";
import type { CanonicalCheckPolicy } from "../domain/canonical-check.js";
import type { CollectionRecord } from "../domain/collections.js";
import type {
    ChainSyncCheckpoint,
    SyncBlockHeader,
} from "../domain/chain-sync.js";

export type SyncRangeResult = {
    checkpoint: ChainSyncCheckpoint;
    canonicalCheck: CanonicalCheckPolicy;
    blocks: readonly SyncBlockHeader[];
    data: OnChainData;
    collections: CollectionRecord[];
};

export interface StoragePort {
    captureSyncCheckpoint(chainId: number): ChainSyncCheckpoint;
    // Atomically validate revision and block identities before writing facts,
    // coverage and balances. Conflicts must leave local state untouched.
    persistSyncResult(input: SyncRangeResult): void;
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
