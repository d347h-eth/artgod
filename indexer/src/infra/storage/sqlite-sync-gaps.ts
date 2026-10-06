import { COLLECTION_STATUS } from "@artgod/shared/types";
import { db } from "@artgod/shared/database";
import type {
    SyncGapProgress,
    SyncGapRange,
    SyncGapStorePort,
} from "../../application/sync-gap-scheduler.js";
import type { SyncGapRepairTarget } from "../../domain/sync-jobs.js";

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
            "VALUES (@chainId, @collectionId, @anchorBlock, @cursorBlock, @repairId, @fromBlock, @toBlock, @retryAt) " +
            "ON CONFLICT(chain_id, collection_id) DO UPDATE SET anchor_block = excluded.anchor_block, cursor_block = excluded.cursor_block, " +
            "pending_job_id = excluded.pending_job_id, pending_from_block = excluded.pending_from_block, pending_to_block = excluded.pending_to_block, retry_at = excluded.retry_at",
    );
    private selectCoverage = db.prepare<[number, number, number, number]>(
        "SELECT block_number FROM collection_sync_blocks " +
            "WHERE chain_id = ? AND collection_id = ? AND block_number BETWEEN ? AND ? ORDER BY block_number DESC",
    );
    private selectDue = db.prepare(
        "SELECT s.collection_id AS collectionId, s.pending_job_id AS repairId, s.anchor_block AS anchorBlock, s.pending_from_block AS fromBlock, s.pending_to_block AS toBlock FROM collection_sync_gap_scans s JOIN collections c ON c.collection_id = s.collection_id AND c.chain_id = s.chain_id WHERE s.chain_id = @chainId AND c.status = @status AND c.bootstrap_anchor_block = s.anchor_block AND s.pending_job_id IS NOT NULL AND s.retry_at <= @now ORDER BY s.retry_at, s.collection_id LIMIT @limit",
    );
    private updateRetry = db.prepare(
        "UPDATE collection_sync_gap_scans SET retry_at = @retryAt " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId AND anchor_block = @anchorBlock " +
            "AND pending_job_id = @repairId AND pending_from_block = @fromBlock AND pending_to_block = @toBlock",
    );
    private advanceRepair = db.prepare(
        "UPDATE collection_sync_gap_scans SET pending_job_id = @nextId, pending_from_block = @nextFrom, pending_to_block = @nextTo, retry_at = @retryAt " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId AND anchor_block = @anchorBlock " +
            "AND pending_job_id = @repairId AND pending_from_block = @fromBlock AND pending_to_block = @toBlock",
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
                          repairId: row.pending_job_id,
                          fromBlock: row.pending_from_block!,
                          toBlock: row.pending_to_block!,
                          retryAt: row.retry_at!,
                      },
        };
    }

    listDue(
        input: Parameters<SyncGapStorePort["listDue"]>[0],
    ): SyncGapRepairTarget[] {
        const rows = this.selectDue.all({
            ...input,
            status: COLLECTION_STATUS.Live,
        }) as SyncGapRepairTarget[];
        return rows;
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
            repairId: progress.pending?.repairId ?? null,
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
        repair: SyncGapRepairTarget,
        retryAt: number,
    ): void {
        this.updateRetry.run({ chainId, ...repair, retryAt });
    }

    recordRepairProgress({
        chainId,
        repair,
        remaining,
        retryAt,
    }: Parameters<SyncGapStorePort["recordRepairProgress"]>[0]): boolean {
        return (
            this.advanceRepair.run({
                chainId,
                ...repair,
                nextId: remaining ? repair.repairId : null,
                nextFrom: remaining?.fromBlock ?? null,
                nextTo: remaining?.toBlock ?? null,
                retryAt: remaining ? retryAt : null,
            }).changes === 1
        );
    }
}
