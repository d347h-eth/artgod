import {
    proveReorgAncestor,
    type ReorgAncestorProof,
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

// Matching islands added by gap repair are not ancestry proof. Compare the
// complete bounded window against one coherent, freshly checked RPC chain.
export async function findCommonAncestor(input: {
    rpc: Pick<RpcProviderPort, "getBlock">;
    storage: ReorgForkStore;
    chainId: number;
    startBlock: number;
    reorgDepth: number;
}): Promise<ReorgAncestorProof | null> {
    const minBlock = Math.max(
        0,
        input.startBlock - Math.max(1, input.reorgDepth),
    );
    const history = input.storage.captureReorgHistory({
        chainId: input.chainId,
        fromBlock: minBlock,
        toBlock: input.startBlock,
    });
    if (!history.headers.length) return null;
    const canonicalBlocks = await fetchCanonicalSyncBlocks({
        rpc: input.rpc,
        fromBlock: minBlock,
        toBlock: input.startBlock,
    });
    return proveReorgAncestor({ history, canonicalBlocks });
}
