import { db } from "@artgod/shared/database";
import type {
    SyncGapProgress,
    SyncGapRange,
    SyncGapStorePort,
} from "../../application/sync-gap-scheduler.js";

type ProgressRow = {
    anchor_block: number;
    cursor_block: number | null;
    pending_job_id: string | null;
    pending_from_block: number | null;
    pending_to_block: number | null;
    retry_at: number | null;
};

export class SqliteSyncGapStore implements SyncGapStorePort {
    private selectProgress = db.prepare<[number, number]>(
        "SELECT anchor_block, cursor_block, pending_job_id, pending_from_block, pending_to_block, retry_at " +
            "FROM collection_sync_gap_scans WHERE chain_id = ? AND collection_id = ?",
    );
    private upsertProgress = db.prepare(
        "INSERT INTO collection_sync_gap_scans (chain_id, collection_id, anchor_block, cursor_block, pending_job_id, pending_from_block, pending_to_block, retry_at) " +
            "VALUES (@chainId, @collectionId, @anchorBlock, @cursorBlock, @jobId, @fromBlock, @toBlock, @retryAt) " +
            "ON CONFLICT(chain_id, collection_id) DO UPDATE SET anchor_block = excluded.anchor_block, cursor_block = excluded.cursor_block, " +
            "pending_job_id = excluded.pending_job_id, pending_from_block = excluded.pending_from_block, pending_to_block = excluded.pending_to_block, retry_at = excluded.retry_at",
    );
    private selectCoverage = db.prepare<[number, number, number, number]>(
        "SELECT block_number FROM collection_sync_blocks " +
            "WHERE chain_id = ? AND collection_id = ? AND block_number BETWEEN ? AND ? ORDER BY block_number DESC",
    );
    private updateRetry = db.prepare<[number, number, number, string]>(
        "UPDATE collection_sync_gap_scans SET retry_at = ? WHERE chain_id = ? AND collection_id = ? AND pending_job_id = ?",
    );
    private finishRepair = db.prepare<[number, number, string]>(
        "UPDATE collection_sync_gap_scans SET pending_job_id = NULL, pending_from_block = NULL, pending_to_block = NULL, retry_at = NULL " +
            "WHERE chain_id = ? AND collection_id = ? AND pending_job_id = ?",
    );

    getProgress(chainId: number, collectionId: number): SyncGapProgress | null {
        const row = this.selectProgress.get(chainId, collectionId) as
            | ProgressRow
            | undefined;
        if (!row) return null;
        return {
            anchorBlock: row.anchor_block,
            cursorBlock: row.cursor_block,
            pending:
                row.pending_job_id === null
                    ? null
                    : {
                          jobId: row.pending_job_id,
                          fromBlock: row.pending_from_block!,
                          toBlock: row.pending_to_block!,
                          retryAt: row.retry_at!,
                      },
        };
    }

    saveProgress(
        chainId: number,
        collectionId: number,
        progress: SyncGapProgress,
    ): void {
        this.upsertProgress.run({
            chainId,
            collectionId,
            anchorBlock: progress.anchorBlock,
            cursorBlock: progress.cursorBlock,
            jobId: progress.pending?.jobId ?? null,
            fromBlock: progress.pending?.fromBlock ?? null,
            toBlock: progress.pending?.toBlock ?? null,
            retryAt: progress.pending?.retryAt ?? null,
        });
    }

    findGap(
        chainId: number,
        collectionId: number,
        window: SyncGapRange,
        batchSize: number,
    ): SyncGapRange | null {
        let cursor = window.toBlock;
        // The covering index provides ordered rows for only this bounded window;
        // no all-history array or per-block RPC/database probes are needed.
        for (const row of this.selectCoverage.iterate(
            chainId,
            collectionId,
            window.fromBlock,
            window.toBlock,
        ) as Iterable<{ block_number: number }>) {
            if (row.block_number < cursor) {
                return {
                    fromBlock: Math.max(
                        row.block_number + 1,
                        cursor - batchSize + 1,
                    ),
                    toBlock: cursor,
                };
            }
            cursor = row.block_number - 1;
        }
        return cursor < window.fromBlock
            ? null
            : {
                  fromBlock: Math.max(window.fromBlock, cursor - batchSize + 1),
                  toBlock: cursor,
              };
    }

    deferRetry(
        chainId: number,
        collectionId: number,
        jobId: string,
        retryAt: number,
    ): void {
        this.updateRetry.run(retryAt, chainId, collectionId, jobId);
    }

    completeRepair(chainId: number, collectionId: number, jobId: string): void {
        this.finishRepair.run(chainId, collectionId, jobId);
    }
}
