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
    last_head_check_at: number | null;
};

const DUE_REPAIRS_QUERY =
    "SELECT s.collection_id AS collectionId, s.pending_job_id AS repairId, s.anchor_block AS anchorBlock, s.pending_from_block AS fromBlock, s.pending_to_block AS toBlock, s.retry_at AS retryAt " +
    "FROM collection_sync_gap_scans s JOIN collections c ON c.collection_id = s.collection_id AND c.chain_id = s.chain_id " +
    "WHERE s.chain_id = @chainId AND c.status = @status AND c.bootstrap_anchor_block = s.anchor_block AND s.pending_job_id IS NOT NULL AND s.retry_at <= @now ";
const DUE_REPAIRS_ORDER = "ORDER BY s.retry_at, s.collection_id LIMIT @limit";
const HEAD_RECHECK_QUERY =
    "SELECT s.collection_id AS collectionId FROM collection_sync_gap_scans s " +
    "JOIN collections c ON c.chain_id = s.chain_id AND c.collection_id = s.collection_id " +
    "WHERE s.chain_id = @chainId AND c.status = @status AND c.bootstrap_anchor_block = s.anchor_block ";

export class SqliteSyncGapStore implements SyncGapStorePort {
    private selectProgress = db.prepare<[number, number]>(
        "SELECT anchor_block, cursor_block, pending_job_id, pending_from_block, pending_to_block, retry_at, last_head_check_at " +
            "FROM collection_sync_gap_scans WHERE chain_id = ? AND collection_id = ?",
    );
    private insertProgress = db.prepare(
        "INSERT INTO collection_sync_gap_scans (chain_id, collection_id, anchor_block, cursor_block, pending_job_id, pending_from_block, pending_to_block, retry_at, last_head_check_at) " +
            "VALUES (@chainId, @collectionId, @anchorBlock, @cursorBlock, @repairId, @fromBlock, @toBlock, @retryAt, @lastHeadCheckAt) " +
            "ON CONFLICT(chain_id, collection_id) DO NOTHING",
    );
    private updateProgress = db.prepare(
        "UPDATE collection_sync_gap_scans SET anchor_block = @anchorBlock, cursor_block = @cursorBlock, " +
            "pending_job_id = @repairId, pending_from_block = @fromBlock, pending_to_block = @toBlock, retry_at = @retryAt, last_head_check_at = @lastHeadCheckAt " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId AND anchor_block = @expectedAnchor " +
            "AND cursor_block IS @expectedCursor AND pending_job_id IS @expectedRepairId " +
            "AND pending_from_block IS @expectedFrom AND pending_to_block IS @expectedTo " +
            "AND retry_at IS @expectedRetryAt AND last_head_check_at IS @expectedHeadCheckAt",
    );
    private selectCoverage = db.prepare<[number, number, number, number]>(
        "SELECT block_number FROM collection_sync_blocks " +
            "WHERE chain_id = ? AND collection_id = ? AND block_number BETWEEN ? AND ? ORDER BY block_number DESC",
    );
    private countCoverage = db.prepare<[number, number, number, number]>(
        "SELECT COUNT(*) AS count FROM collection_sync_blocks " +
            "WHERE chain_id = ? AND collection_id = ? AND block_number BETWEEN ? AND ?",
    );
    private selectUncheckedHead = db.prepare(
        HEAD_RECHECK_QUERY +
            "AND s.last_head_check_at IS NULL ORDER BY s.collection_id LIMIT @limit",
    );
    private selectDueHead = db.prepare(
        HEAD_RECHECK_QUERY +
            "AND s.last_head_check_at <= @checkedBefore ORDER BY s.last_head_check_at, s.collection_id LIMIT @limit",
    );
    private selectDue = db.prepare(DUE_REPAIRS_QUERY + DUE_REPAIRS_ORDER);
    private selectDueAfter = db.prepare(
        DUE_REPAIRS_QUERY +
            "AND (s.retry_at, s.collection_id) > (@afterRetryAt, @afterCollectionId) " +
            DUE_REPAIRS_ORDER,
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
            lastHeadCheckAt: row.last_head_check_at,
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

    listDuePage(
        input: Parameters<SyncGapStorePort["listDuePage"]>[0],
    ): ReturnType<SyncGapStorePort["listDuePage"]> {
        const bindings = {
            chainId: input.chainId,
            now: input.now,
            limit: input.limit,
            status: COLLECTION_STATUS.Live,
        };
        const rows = (
            input.after
                ? this.selectDueAfter.all({
                      ...bindings,
                      afterRetryAt: input.after.retryAt,
                      afterCollectionId: input.after.collectionId,
                  })
                : this.selectDue.all(bindings)
        ) as (SyncGapRepairTarget & {
            retryAt: number;
        })[];
        const last = rows.at(-1);
        return {
            repairs: rows.map(({ retryAt: _retryAt, ...repair }) => repair),
            cursor: last
                ? { retryAt: last.retryAt, collectionId: last.collectionId }
                : null,
        };
    }

    saveProgress({
        chainId,
        collectionId,
        expected,
        progress,
    }: Parameters<SyncGapStorePort["saveProgress"]>[0]): boolean {
        const bindings = {
            chainId,
            collectionId,
            anchorBlock: progress.anchorBlock,
            cursorBlock: progress.cursorBlock,
            repairId: progress.pending?.repairId ?? null,
            fromBlock: progress.pending?.fromBlock ?? null,
            toBlock: progress.pending?.toBlock ?? null,
            retryAt: progress.pending?.retryAt ?? null,
            lastHeadCheckAt: progress.lastHeadCheckAt,
        };
        const result =
            expected === null
                ? this.insertProgress.run(bindings)
                : this.updateProgress.run({
                      ...bindings,
                      expectedAnchor: expected.anchorBlock,
                      expectedCursor: expected.cursorBlock,
                      expectedRepairId: expected.pending?.repairId ?? null,
                      expectedFrom: expected.pending?.fromBlock ?? null,
                      expectedTo: expected.pending?.toBlock ?? null,
                      expectedRetryAt: expected.pending?.retryAt ?? null,
                      expectedHeadCheckAt: expected.lastHeadCheckAt,
                  });
        return result.changes === 1;
    }

    listHeadRecheckCollectionIds({
        chainId,
        checkedBefore,
        limit,
    }: Parameters<
        SyncGapStorePort["listHeadRecheckCollectionIds"]
    >[0]): number[] {
        const bindings = { chainId, status: COLLECTION_STATUS.Live, limit };
        // Separate NULL and elapsed checks keep both reads indexed and bounded;
        // fresh rows need no HEAD polling, and downtime counts toward the interval.
        const unchecked = this.selectUncheckedHead.all(bindings) as {
            collectionId: number;
        }[];
        const due =
            unchecked.length < limit
                ? (this.selectDueHead.all({
                      ...bindings,
                      checkedBefore,
                      limit: limit - unchecked.length,
                  }) as { collectionId: number }[])
                : [];
        return [...unchecked, ...due].map((row) => row.collectionId);
    }

    findNewestGap(
        chainId: number,
        collectionId: number,
        window: SyncGapRange,
        batchSize: number,
    ): SyncGapRange | null {
        // Use a read transaction, never the global writer, while checking a large
        // newer span. Counts use the unique covering collection/block index.
        return db.raw.transaction(() => {
            let from = window.fromBlock;
            let to = window.toBlock;
            const count = (lower: number, upper: number) =>
                (
                    this.countCoverage.get(
                        chainId,
                        collectionId,
                        lower,
                        upper,
                    ) as { count: number }
                ).count;
            const covered = count(from, to);
            if (covered === to - from + 1) return null;
            if (covered > 0) {
                while (from < to) {
                    const middle = Math.floor((from + to + 1) / 2);
                    if (count(middle, to) < to - middle + 1) from = middle;
                    else to = middle - 1;
                }
            }
            // Reuse the ordinary gap boundary logic once the newest missing
            // block is known; this reads at most one repair-sized suffix.
            return this.findGap(
                chainId,
                collectionId,
                {
                    fromBlock: Math.max(window.fromBlock, to - batchSize + 1),
                    toBlock: to,
                },
                batchSize,
            );
        })();
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
