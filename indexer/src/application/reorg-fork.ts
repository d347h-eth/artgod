import {
    ChainSyncConflict,
    type VerifiedChainBlock,
} from "../domain/chain-sync.js";
import type { RpcProviderPort } from "../ports/rpc.js";
import type { StoragePort } from "../ports/storage.js";

// Missing local history is not proof of a fork. Only a stored header matching a
// fresh RPC read authorizes rollback; absence within the bounded search is null.
export async function findCommonAncestor(input: {
    rpc: Pick<RpcProviderPort, "getBlock">;
    storage: Pick<StoragePort, "getBlockHash">;
    chainId: number;
    startBlock: number;
    reorgDepth: number;
}): Promise<VerifiedChainBlock | null> {
    const minBlock = Math.max(
        0,
        input.startBlock - Math.max(1, input.reorgDepth),
    );
    for (let number = input.startBlock - 1; number >= minBlock; number -= 1) {
        const storedHash = input.storage.getBlockHash(input.chainId, number);
        if (!storedHash) continue;
        const block = await input.rpc.getBlock(number, { fresh: true });
        if (block.number !== number) {
            throw new ChainSyncConflict(
                "Fork search RPC returned the wrong block",
            );
        }
        if (block.hash === storedHash)
            return { ...block, chainId: input.chainId };
    }
    return null;
}
