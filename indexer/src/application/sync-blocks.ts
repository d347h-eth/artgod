import { ChainSyncConflict } from "../domain/chain-sync.js";
import { assertSyncBlockHeaders } from "../domain/sync-result.js";
import type { RpcBlock, RpcProviderPort } from "../ports/rpc.js";

// Read after all logs, bypass the block cache, and recheck the range tip. Parent
// links prove a consistent range; the tip check catches a reorg during the reads.
export async function fetchCanonicalSyncBlocks(input: {
    rpc: Pick<RpcProviderPort, "getBlock">;
    fromBlock: number;
    toBlock: number;
}): Promise<RpcBlock[]> {
    const blocks: RpcBlock[] = [];
    for (let number = input.fromBlock; number <= input.toBlock; number += 1) {
        const block = await input.rpc.getBlock(number, { fresh: true });
        if (block.number !== number) {
            throw new ChainSyncConflict("Sync RPC returned the wrong block");
        }
        blocks.push(block);
    }
    assertSyncBlockHeaders(blocks);
    const tip = blocks.at(-1);
    if (tip) {
        const current = await input.rpc.getBlock(tip.number, { fresh: true });
        if (current.number !== tip.number || current.hash !== tip.hash) {
            throw new ChainSyncConflict(
                "Sync range changed during header reads",
            );
        }
    }
    return blocks;
}
