import { db } from "@artgod/shared/database";
import {
    ChainSyncConflict,
    type ChainSyncCheckpoint,
} from "../../domain/chain-sync.js";

/** Shared SQL translation for work captured before a rollback; callers own the transaction. */
export function captureChainSyncCheckpoint(
    chainId: number,
): ChainSyncCheckpoint {
    const row = db
        .prepare("SELECT revision FROM chain_sync_revisions WHERE chain_id=?")
        .get(chainId) as { revision: number } | undefined;
    return { chainId, revision: row?.revision ?? 0 };
}

export function assertChainSyncCheckpoint(
    checkpoint: ChainSyncCheckpoint,
): void {
    if (
        captureChainSyncCheckpoint(checkpoint.chainId).revision !==
        checkpoint.revision
    )
        throw new ChainSyncConflict("Work predates a committed chain rollback");
}

export function advanceChainSyncRevision(chainId: number): void {
    db.prepare(
        "INSERT INTO chain_sync_revisions(chain_id,revision) VALUES (?,1) ON CONFLICT(chain_id) DO UPDATE SET revision=revision+1",
    ).run(chainId);
}
