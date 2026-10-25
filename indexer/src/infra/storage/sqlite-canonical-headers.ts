import { db } from "@artgod/shared/database";
import {
    StoredBlockHashConflict,
    type ChainSyncCheckpoint,
    type SyncBlockHeader,
} from "../../domain/chain-sync.js";
import { assertSyncBlockHeaders } from "../../domain/sync-result.js";
import { assertChainSyncCheckpoint } from "./sqlite-chain-revisions.js";

/** All header writers share the same identity fence. The caller owns the writer
 * transaction and any facts or coverage; a header alone never means range sync. */
export function persistCanonicalBlocks(
    checkpoint: ChainSyncCheckpoint,
    blocks: readonly SyncBlockHeader[],
    pendingCheck: (block: SyncBlockHeader) => boolean,
): void {
    assertChainSyncCheckpoint(checkpoint);
    assertSyncBlockHeaders(blocks);
    const select = db.prepare(
        "SELECT block_hash AS hash FROM blocks WHERE chain_id=? AND block_number=?",
    );
    const insert = db.prepare(
        "INSERT INTO blocks(chain_id,block_number,block_hash,parent_hash,timestamp,canonical_check_pending) VALUES (?,?,?,?,?,?) ON CONFLICT(chain_id,block_number) DO NOTHING",
    );
    for (const block of blocks) {
        const stored = select.get(checkpoint.chainId, block.number) as
            | { hash: string }
            | undefined;
        if (stored && stored.hash !== block.hash) {
            throw new StoredBlockHashConflict(
                {
                    chainId: checkpoint.chainId,
                    blockNumber: block.number,
                    blockHash: stored.hash,
                    checkpoint,
                },
                block.hash,
            );
        }
        // An existing identical header retains its unfinished check/backoff or its
        // completed proof. Repeated observations do not create an endless check loop.
        if (!stored)
            insert.run(
                checkpoint.chainId,
                block.number,
                block.hash,
                block.parentHash,
                block.timestamp,
                pendingCheck(block) ? 1 : 0,
            );
    }
}
