import { COLLECTION_STATUS } from "@artgod/shared/types";
import { db } from "@artgod/shared/database";
import type {
    SyncGapProgress,
    SyncGapRange,
    SyncGapStorePort,
    SyncGapHeadCheckPosition,
} from "../../application/sync-gap-scheduler.js";
import type {
    SyncGapRepairTarget,
    SyncGapRepairCandidate,
} from "../../domain/sync-gap-repair.js";

type ProgressRow = {
    anchor_block: number;
    cursor_block: number | null;
    pending_job_id: string | null;
    pending_from_block: number | null;
    pending_to_block: number | null;
    retry_at: number | null;
    last_head_check_at: number | null;
};

// SQLite CROSS JOIN keeps the ordered intent index as the outer loop. With an
// ordinary join, ANALYZE can make SQLite visit/sort every live collection before
// applying LIMIT. Eligibility still requires the exact live collection/anchor.
const LIVE_GAP_PROGRESS_QUERY =
    "FROM collection_sync_gap_scans s CROSS JOIN collections c " +
    "WHERE s.chain_id = @chainId AND c.collection_id = s.collection_id AND c.chain_id = s.chain_id " +
    "AND c.status = @status AND c.bootstrap_anchor_block = s.anchor_block ";
const PENDING_REPAIRS_QUERY =
    LIVE_GAP_PROGRESS_QUERY + "AND s.pending_job_id IS NOT NULL ";
const HEAD_RECHECK_QUERY =
    "SELECT s.collection_id AS collectionId, s.last_head_check_at AS lastHeadCheckAt " +
    LIVE_GAP_PROGRESS_QUERY;

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
    private probeUncheckedHead = db.prepare(
        HEAD_RECHECK_QUERY +
            "AND s.last_head_check_at IS NULL ORDER BY s.collection_id LIMIT 1",
    );
    private probeDueHead = db.prepare(
        HEAD_RECHECK_QUERY +
            "AND s.last_head_check_at <= @checkedBefore ORDER BY s.last_head_check_at, s.collection_id LIMIT 1",
    );
    private selectUncheckedHeadAfter = db.prepare(
        HEAD_RECHECK_QUERY +
            "AND s.anchor_block <= @headBlock AND s.last_head_check_at IS NULL " +
            "AND s.collection_id > @afterCollectionId ORDER BY s.collection_id LIMIT @limit",
    );
    private selectDueHeadAfter = db.prepare(
        HEAD_RECHECK_QUERY +
            "AND s.anchor_block <= @headBlock AND s.last_head_check_at <= @checkedBefore " +
            "AND (s.last_head_check_at, s.collection_id) > (@afterHeadCheckAt, @afterCollectionId) " +
            "ORDER BY s.last_head_check_at, s.collection_id LIMIT @limit",
    );
    private selectNewest = db.prepare(
        "SELECT s.pending_to_block AS toBlock " +
            PENDING_REPAIRS_QUERY +
            "AND s.pending_to_block <= @upperBound " +
            "ORDER BY s.pending_to_block DESC LIMIT 1",
    );
    private selectDueAtNewest = db.prepare(
        "SELECT s.collection_id AS collectionId, s.pending_job_id AS repairId, s.anchor_block AS anchorBlock, s.pending_from_block AS fromBlock, s.pending_to_block AS toBlock " +
            PENDING_REPAIRS_QUERY +
            "AND s.pending_to_block = @toBlock AND s.retry_at <= @now " +
            "ORDER BY s.retry_at, s.collection_id LIMIT @limit",
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

    listDueRepairsAtNewestPendingHeight({
        chainId,
        now,
        limit,
        upperBound,
    }: Parameters<
        SyncGapStorePort["listDueRepairsAtNewestPendingHeight"]
    >[0]): SyncGapRepairTarget[] {
        return db.raw.transaction(() => {
            const bindings = { chainId, status: COLLECTION_STATUS.Live };
            const newest = this.selectNewest.get({
                ...bindings,
                upperBound,
            }) as { toBlock: number } | undefined;
            // Find newest intent before retry filtering. A newer failed range
            // must not hand scarce RPC capacity back to older missing history.
            return newest
                ? (this.selectDueAtNewest.all({
                      ...bindings,
                      toBlock: newest.toBlock,
                      now,
                      limit,
                  }) as SyncGapRepairTarget[])
                : [];
        })();
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

    hasHeadRechecksDue({
        chainId,
        checkedBefore,
    }: Parameters<SyncGapStorePort["hasHeadRechecksDue"]>[0]): boolean {
        const bindings = { chainId, status: COLLECTION_STATUS.Live };
        return !!(
            this.probeUncheckedHead.get(bindings) ??
            this.probeDueHead.get({ ...bindings, checkedBefore })
        );
    }

    listHeadRechecksAfter({
        chainId,
        checkedBefore,
        headBlock,
        limit,
        after,
    }: Parameters<
        SyncGapStorePort["listHeadRechecksAfter"]
    >[0]): SyncGapHeadCheckPosition[] {
        return db.raw.transaction(() => {
            const bindings = {
                chainId,
                status: COLLECTION_STATUS.Live,
                headBlock,
                limit,
            };
            const unchecked =
                after === null || after.lastHeadCheckAt === null
                    ? (this.selectUncheckedHeadAfter.all({
                          ...bindings,
                          afterCollectionId: after?.collectionId ?? 0,
                      }) as SyncGapHeadCheckPosition[])
                    : [];
            // NULL times form the first partition. Nonnegative persisted check
            // times make (-1, 0) the starting position of the checked partition.
            const due =
                unchecked.length < limit
                    ? (this.selectDueHeadAfter.all({
                          ...bindings,
                          checkedBefore,
                          afterHeadCheckAt: after?.lastHeadCheckAt ?? -1,
                          afterCollectionId:
                              after !== null && after.lastHeadCheckAt !== null
                                  ? after.collectionId
                                  : 0,
                          limit: limit - unchecked.length,
                      }) as SyncGapHeadCheckPosition[])
                    : [];
            return [...unchecked, ...due];
        })();
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

    reconcileRepairCoverage({
        chainId,
        repair,
        batchSize,
        now,
    }: Parameters<
        SyncGapStorePort["reconcileRepairCoverage"]
    >[0]): SyncGapRepairCandidate | null {
        return db.writeTransaction(() => {
            const progress = this.getProgress(chainId, repair.collectionId);
            if (
                progress?.anchorBlock !== repair.anchorBlock ||
                progress.pending?.repairId !== repair.repairId ||
                progress.pending.fromBlock !== repair.fromBlock ||
                progress.pending.toBlock !== repair.toBlock
            )
                return null;
            const window = {
                fromBlock: Math.max(
                    repair.fromBlock,
                    repair.toBlock - batchSize + 1,
                ),
                toBlock: repair.toBlock,
            };
            const missing = this.findGap(
                chainId,
                repair.collectionId,
                window,
                batchSize,
            );
            const toBlock = missing?.toBlock ?? window.fromBlock - 1;
            if (toBlock !== repair.toBlock) {
                this.recordRepairProgress({
                    chainId,
                    repair,
                    retryAt: now,
                    remaining:
                        toBlock >= repair.fromBlock
                            ? { fromBlock: repair.fromBlock, toBlock }
                            : null,
                });
            }
            return missing ? { repair: { ...repair, toBlock }, missing } : null;
        })();
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
