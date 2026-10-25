import {
    proveReorgAncestor,
    assertReorgHistory,
    type ReorgHistoryProof,
    type ReorgHistorySnapshot,
} from "../domain/reorg-fork.js";
import type { RpcProviderPort } from "../ports/rpc.js";
import { fetchCanonicalSyncBlocks } from "./sync-blocks.js";

export interface ReorgForkStore {
    // One local read snapshot, without a writer held during RPC acquisition.
    captureReorgHistory(input: {
        chainId: number;
        fromBlock: number;
        toBlock: number;
    }): ReorgHistorySnapshot;
}

// Compare accepted local lineage against independently acquired replacement
// headers. Recovery cannot depend on the forward writer its mismatch blocks.
export async function findCommonAncestor(input: {
    rpc: Pick<RpcProviderPort, "getBlock">;
    storage: ReorgForkStore;
    chainId: number;
    startBlock: number;
    reorgDepth: number;
}): Promise<ReorgHistoryProof | null> {
    const minBlock = Math.max(
        0,
        input.startBlock - Math.max(1, input.reorgDepth),
    );
    const history = input.storage.captureReorgHistory({
        chainId: input.chainId,
        fromBlock: minBlock,
        toBlock: input.startBlock,
    });
    assertReorgHistory(history);
    const canonicalBlocks = await fetchCanonicalSyncBlocks({
        rpc: input.rpc,
        fromBlock: history.fromBlock,
        toBlock: history.toBlock,
    });
    return proveReorgAncestor({ history, canonicalBlocks });
}
