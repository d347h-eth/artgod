import { db } from "@artgod/shared/database";
import type {
    BootstrapMetadataTask,
    BootstrapMetadataTaskCounts,
    BootstrapMetadataTaskSeed,
    BootstrapSnapshotPort,
    BootstrapSnapshotRow,
    SnapshotFinalizeInput,
} from "../../ports/bootstrap.js";

const ZERO_HASH =
    "0x0000000000000000000000000000000000000000000000000000000000000000";

// Raw row shape returned by sqlite for due metadata snapshot task queries.
// We keep it explicit so storage-to-domain mapping stays centralized and reusable.
type BootstrapMetadataTaskDbRow = {
    chain_id: number;
    collection_id: string;
    contract_address: string;
    token_id: string;
    standard: BootstrapMetadataTask["standard"];
    anchor_block: number;
    anchor_block_hash: string;
    anchor_block_timestamp: number;
    status: BootstrapMetadataTask["status"];
    attempts: number;
    next_attempt_at: number;
};

export class SqliteBootstrapStorage implements BootstrapSnapshotPort {
    private resetSnapshotStmt = db.prepare<{
        chainId: number;
        collectionId: string;
    }>(
        "DELETE FROM nft_balance_snapshots " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId",
    );
    private insertSnapshotStmt = db.prepare<BootstrapSnapshotRow>(
        "INSERT INTO nft_balance_snapshots " +
            "(chain_id, collection_id, contract_address, token_id, owner, anchor_block) " +
            "VALUES (@chainId, @collectionId, @contract, @tokenId, @owner, @anchorBlock)",
    );
    private deleteBalancesStmt = db.prepare<{
        chainId: number;
        contract: string;
    }>(
        "DELETE FROM nft_balances WHERE chain_id = @chainId AND contract_address = @contract",
    );
    private insertBalancesFromSnapshotStmt = db.prepare<{
        chainId: number;
        collectionId: string;
        contract: string;
        anchorBlock: number;
        anchorHash: string;
        anchorTimestamp: number;
        zeroHash: string;
    }>(
        "INSERT INTO nft_balances " +
            "(chain_id, contract_address, token_id, owner, amount, " +
            "last_block_number, last_block_hash, last_block_timestamp, " +
            "last_tx_hash, last_log_index, updated_at) " +
            "SELECT chain_id, contract_address, token_id, owner, '1', " +
            "@anchorBlock, @anchorHash, @anchorTimestamp, " +
            "@zeroHash, 0, CURRENT_TIMESTAMP " +
            "FROM nft_balance_snapshots " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId",
    );
    private resetMetadataTasksStmt = db.prepare<{
        chainId: number;
        collectionId: string;
    }>(
        "DELETE FROM bootstrap_metadata_snapshot_tasks " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId",
    );
    private insertMetadataTaskStmt = db.prepare<BootstrapMetadataTaskSeed>(
        "INSERT INTO bootstrap_metadata_snapshot_tasks " +
            "(chain_id, collection_id, contract_address, token_id, standard, anchor_block, anchor_block_hash, anchor_block_timestamp, status, attempts, next_attempt_at) " +
            "VALUES (@chainId, @collectionId, @contract, @tokenId, @standard, @anchorBlock, @anchorHash, @anchorTimestamp, 'pending', 0, 0)",
    );
    private selectMetadataTasksDueStmt = db.prepare<{
        chainId: number;
        collectionId: string;
        nowMs: number;
        limit: number;
    }>(
        "SELECT chain_id, collection_id, contract_address, token_id, standard, anchor_block, anchor_block_hash, anchor_block_timestamp, status, attempts, next_attempt_at " +
            "FROM bootstrap_metadata_snapshot_tasks " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId " +
            "AND status IN ('pending', 'retry') AND next_attempt_at <= @nowMs " +
            "ORDER BY next_attempt_at ASC, token_id ASC LIMIT @limit",
    );
    private markMetadataTaskSucceededStmt = db.prepare<{
        chainId: number;
        collectionId: string;
        tokenId: string;
        attempts: number;
    }>(
        "UPDATE bootstrap_metadata_snapshot_tasks SET " +
            "status = 'succeeded', attempts = @attempts, last_error = NULL, last_error_at = NULL, updated_at = CURRENT_TIMESTAMP " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId AND token_id = @tokenId",
    );
    private markMetadataTaskRetryStmt = db.prepare<{
        chainId: number;
        collectionId: string;
        tokenId: string;
        attempts: number;
        nextAttemptAt: number;
        lastError: string;
        failedTerminal: number;
        nowMs: number;
    }>(
        "UPDATE bootstrap_metadata_snapshot_tasks SET " +
            "status = CASE WHEN @failedTerminal = 1 THEN 'failed_terminal' ELSE 'retry' END, " +
            "attempts = @attempts, next_attempt_at = @nextAttemptAt, last_error = @lastError, last_error_at = @nowMs, updated_at = CURRENT_TIMESTAMP " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId AND token_id = @tokenId",
    );
    private selectMetadataTaskCountsStmt = db.prepare<{
        chainId: number;
        collectionId: string;
    }>(
        "SELECT status, COUNT(*) AS count FROM bootstrap_metadata_snapshot_tasks " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId GROUP BY status",
    );
    private selectMetadataTaskTokenIdsStmt = db.prepare<{
        chainId: number;
        collectionId: string;
    }>(
        "SELECT token_id FROM bootstrap_metadata_snapshot_tasks " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId " +
            "ORDER BY token_id ASC",
    );

    resetSnapshot(chainId: number, collectionId: string): void {
        this.resetSnapshotStmt.run({ chainId, collectionId });
    }

    insertSnapshotRows(rows: BootstrapSnapshotRow[]): void {
        if (rows.length === 0) return;
        const insertMany = db.raw.transaction(
            (batch: BootstrapSnapshotRow[]) => {
                for (const row of batch) {
                    this.insertSnapshotStmt.run(row);
                }
            },
        );
        insertMany(rows);
    }

    finalizeSnapshot(input: SnapshotFinalizeInput): void {
        const finalize = db.raw.transaction((params: SnapshotFinalizeInput) => {
            this.deleteBalancesStmt.run({
                chainId: params.chainId,
                contract: params.contract,
            });
            this.insertBalancesFromSnapshotStmt.run({
                chainId: params.chainId,
                collectionId: params.collectionId,
                contract: params.contract,
                anchorBlock: params.anchorBlock,
                anchorHash: params.anchorHash,
                anchorTimestamp: params.anchorTimestamp,
                zeroHash: ZERO_HASH,
            });
        });
        finalize(input);
    }

    resetMetadataTasks(chainId: number, collectionId: string): void {
        this.resetMetadataTasksStmt.run({ chainId, collectionId });
    }

    insertMetadataTasks(rows: BootstrapMetadataTaskSeed[]): void {
        if (rows.length === 0) return;
        const insertMany = db.raw.transaction(
            (batch: BootstrapMetadataTaskSeed[]) => {
                for (const row of batch) {
                    this.insertMetadataTaskStmt.run(row);
                }
            },
        );
        insertMany(rows);
    }

    listMetadataTasksDueNow(
        chainId: number,
        collectionId: string,
        nowMs: number,
        limit: number,
    ): BootstrapMetadataTask[] {
        const rows = this.selectMetadataTasksDueStmt.all({
            chainId,
            collectionId,
            nowMs,
            limit,
        }) as BootstrapMetadataTaskDbRow[];
        return rows.map(mapBootstrapMetadataTaskDbRow);
    }

    markMetadataTaskSucceeded(
        chainId: number,
        collectionId: string,
        tokenId: string,
        attempts: number,
    ): void {
        this.markMetadataTaskSucceededStmt.run({
            chainId,
            collectionId,
            tokenId,
            attempts,
        });
    }

    markMetadataTaskRetry(
        chainId: number,
        collectionId: string,
        tokenId: string,
        attempts: number,
        nextAttemptAt: number,
        lastError: string,
        failedTerminal: boolean,
    ): void {
        this.markMetadataTaskRetryStmt.run({
            chainId,
            collectionId,
            tokenId,
            attempts,
            nextAttemptAt,
            lastError,
            failedTerminal: failedTerminal ? 1 : 0,
            nowMs: Date.now(),
        });
    }

    getMetadataTaskCounts(
        chainId: number,
        collectionId: string,
    ): BootstrapMetadataTaskCounts {
        const counts: BootstrapMetadataTaskCounts = {
            pending: 0,
            retry: 0,
            succeeded: 0,
            failedTerminal: 0,
            total: 0,
        };
        const rows = this.selectMetadataTaskCountsStmt.all({
            chainId,
            collectionId,
        }) as Array<{ status: string; count: number }>;
        for (const row of rows) {
            const value = Number(row.count) || 0;
            if (row.status === "pending") counts.pending = value;
            if (row.status === "retry") counts.retry = value;
            if (row.status === "succeeded") counts.succeeded = value;
            if (row.status === "failed_terminal") counts.failedTerminal = value;
            counts.total += value;
        }
        return counts;
    }

    listMetadataTaskTokenIds(chainId: number, collectionId: string): string[] {
        const rows = this.selectMetadataTaskTokenIdsStmt.all({
            chainId,
            collectionId,
        }) as Array<{ token_id: string }>;
        return rows.map((row) => row.token_id);
    }
}

function mapBootstrapMetadataTaskDbRow(
    row: BootstrapMetadataTaskDbRow,
): BootstrapMetadataTask {
    return {
        chainId: row.chain_id,
        collectionId: row.collection_id,
        contract: row.contract_address,
        tokenId: row.token_id,
        standard: row.standard,
        anchorBlock: row.anchor_block,
        anchorHash: row.anchor_block_hash as `0x${string}`,
        anchorTimestamp: row.anchor_block_timestamp,
        status: row.status,
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at,
    };
}
