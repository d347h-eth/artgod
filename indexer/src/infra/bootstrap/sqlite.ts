import { db } from "@artgod/shared/database";
import type {
    BootstrapMetadataTask,
    BootstrapMetadataTaskCounts,
    BootstrapMetadataTaskSeed,
    BootstrapImageCacheTask,
    BootstrapImageCacheTaskCounts,
    BootstrapSnapshotPort,
    BootstrapSnapshotRow,
    SnapshotFinalizeInput,
} from "../../ports/bootstrap.js";

const ZERO_HASH =
    "0x0000000000000000000000000000000000000000000000000000000000000000";

// Raw row shape returned by sqlite for due metadata snapshot task queries.
// We keep it explicit so storage-to-domain mapping stays centralized and reusable.
type BootstrapMetadataTaskDbRow = {
    run_id: number;
    chain_id: number;
    collection_id: number;
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

type BootstrapImageCacheTaskDbRow = {
    run_id: number;
    chain_id: number;
    collection_id: number;
    contract_address: string;
    token_id: string;
    source_image_url: string;
    requested_max_dimension: number | null;
    status: BootstrapImageCacheTask["status"];
    attempts: number;
    next_attempt_at: number;
};

export class SqliteBootstrapStorage implements BootstrapSnapshotPort {
    private resetSnapshotStmt = db.prepare<{ runId: number }>(
        "DELETE FROM nft_balance_snapshots WHERE run_id = @runId",
    );
    private insertSnapshotStmt = db.prepare<BootstrapSnapshotRow>(
        "INSERT INTO nft_balance_snapshots " +
            "(run_id, chain_id, collection_id, contract_address, token_id, owner, anchor_block) " +
            "VALUES (@runId, @chainId, @collectionId, lower(@contract), @tokenId, lower(@owner), @anchorBlock)",
    );
    private deleteBalancesStmt = db.prepare<{
        chainId: number;
        collectionId: number;
    }>(
        "DELETE FROM nft_balances WHERE chain_id = @chainId AND collection_id = @collectionId",
    );
    private insertBalancesFromSnapshotStmt = db.prepare<{
        runId: number;
        anchorBlock: number;
        anchorHash: string;
        anchorTimestamp: number;
        zeroHash: string;
    }>(
        "INSERT INTO nft_balances " +
            "(chain_id, collection_id, contract_address, token_id, owner, amount, " +
            "last_block_number, last_block_hash, last_block_timestamp, " +
            "last_tx_hash, last_log_index, updated_at) " +
            "SELECT chain_id, collection_id, lower(contract_address), token_id, lower(owner), '1', " +
            "@anchorBlock, @anchorHash, @anchorTimestamp, " +
            "@zeroHash, 0, CURRENT_TIMESTAMP " +
            "FROM nft_balance_snapshots " +
            "WHERE run_id = @runId",
    );
    private resetMetadataTasksStmt = db.prepare<{ runId: number }>(
        "DELETE FROM bootstrap_metadata_snapshot_tasks " +
            "WHERE run_id = @runId",
    );
    private insertMetadataTaskStmt = db.prepare<BootstrapMetadataTaskSeed>(
        "INSERT INTO bootstrap_metadata_snapshot_tasks " +
            "(run_id, chain_id, collection_id, contract_address, token_id, standard, anchor_block, anchor_block_hash, anchor_block_timestamp, status, attempts, next_attempt_at) " +
            "VALUES (@runId, @chainId, @collectionId, lower(@contract), @tokenId, @standard, @anchorBlock, @anchorHash, @anchorTimestamp, 'pending', 0, 0)",
    );
    private selectMetadataTasksDueStmt = db.prepare<{
        runId: number;
        nowMs: number;
        limit: number;
    }>(
        "SELECT run_id, chain_id, collection_id, contract_address, token_id, standard, anchor_block, anchor_block_hash, anchor_block_timestamp, status, attempts, next_attempt_at " +
            "FROM bootstrap_metadata_snapshot_tasks " +
            "WHERE run_id = @runId " +
            "AND status IN ('pending', 'retry') AND next_attempt_at <= @nowMs " +
            "ORDER BY next_attempt_at ASC, token_id ASC LIMIT @limit",
    );
    private markMetadataTaskSucceededStmt = db.prepare<{
        runId: number;
        tokenId: string;
        attempts: number;
    }>(
        "UPDATE bootstrap_metadata_snapshot_tasks SET " +
            "status = 'succeeded', attempts = @attempts, last_error = NULL, last_error_at = NULL, updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = @runId AND token_id = @tokenId",
    );
    private markMetadataTaskRetryStmt = db.prepare<{
        runId: number;
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
            "WHERE run_id = @runId AND token_id = @tokenId",
    );
    private selectMetadataTaskCountsStmt = db.prepare<{ runId: number }>(
        "SELECT status, COUNT(*) AS count FROM bootstrap_metadata_snapshot_tasks " +
            "WHERE run_id = @runId GROUP BY status",
    );
    private selectMetadataTaskTokenIdsStmt = db.prepare<{ runId: number }>(
        "SELECT token_id FROM bootstrap_metadata_snapshot_tasks " +
            "WHERE run_id = @runId " +
            "ORDER BY token_id ASC",
    );
    private resetImageCacheTasksStmt = db.prepare<{ runId: number }>(
        "DELETE FROM token_image_cache WHERE run_id = @runId",
    );
    private seedImageCacheTasksStmt = db.prepare<{
        runId: number;
        requestedMaxDimension: number | null;
    }>(
        "INSERT INTO token_image_cache " +
            "(run_id, chain_id, collection_id, contract_address, token_id, source_image_url, requested_max_dimension, status, attempts, next_attempt_at, cache_key, content_type, source_bytes, cached_bytes, width, height, relative_path, public_path, last_error, last_error_at) " +
            "SELECT t.run_id, t.chain_id, t.collection_id, lower(t.contract_address), t.token_id, m.image, @requestedMaxDimension, 'pending', 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL " +
            "FROM bootstrap_metadata_snapshot_tasks t " +
            "JOIN token_metadata m ON m.chain_id = t.chain_id " +
            "AND m.collection_id = t.collection_id " +
            "AND m.token_id = t.token_id " +
            "WHERE t.run_id = @runId AND t.status = 'succeeded' " +
            "AND m.image IS NOT NULL AND trim(m.image) <> '' " +
            "ON CONFLICT(chain_id, collection_id, token_id) DO UPDATE SET " +
            "run_id = excluded.run_id, contract_address = excluded.contract_address, " +
            "source_image_url = excluded.source_image_url, requested_max_dimension = excluded.requested_max_dimension, " +
            "status = CASE WHEN token_image_cache.source_image_url = excluded.source_image_url " +
            "AND COALESCE(token_image_cache.requested_max_dimension, -1) = COALESCE(excluded.requested_max_dimension, -1) " +
            "AND token_image_cache.status = 'succeeded' THEN 'succeeded' ELSE 'pending' END, " +
            "attempts = CASE WHEN token_image_cache.source_image_url = excluded.source_image_url " +
            "AND COALESCE(token_image_cache.requested_max_dimension, -1) = COALESCE(excluded.requested_max_dimension, -1) " +
            "AND token_image_cache.status = 'succeeded' THEN token_image_cache.attempts ELSE 0 END, " +
            "next_attempt_at = CASE WHEN token_image_cache.source_image_url = excluded.source_image_url " +
            "AND COALESCE(token_image_cache.requested_max_dimension, -1) = COALESCE(excluded.requested_max_dimension, -1) " +
            "AND token_image_cache.status = 'succeeded' THEN token_image_cache.next_attempt_at ELSE 0 END, " +
            "last_error = CASE WHEN token_image_cache.status = 'succeeded' THEN token_image_cache.last_error ELSE NULL END, " +
            "last_error_at = CASE WHEN token_image_cache.status = 'succeeded' THEN token_image_cache.last_error_at ELSE NULL END, " +
            "updated_at = CURRENT_TIMESTAMP",
    );
    private selectImageCacheTasksDueStmt = db.prepare<{
        runId: number;
        nowMs: number;
        limit: number;
    }>(
        "SELECT run_id, chain_id, collection_id, contract_address, token_id, source_image_url, requested_max_dimension, status, attempts, next_attempt_at " +
            "FROM token_image_cache " +
            "WHERE run_id = @runId " +
            "AND status IN ('pending', 'retry') AND next_attempt_at <= @nowMs " +
            "ORDER BY next_attempt_at ASC, token_id ASC LIMIT @limit",
    );
    private markImageCacheTaskSucceededStmt = db.prepare<{
        runId: number;
        tokenId: string;
        attempts: number;
        cacheKey: string;
        contentType: string;
        sourceBytes: number;
        cachedBytes: number;
        width: number | null;
        height: number | null;
        relativePath: string;
        publicPath: string;
    }>(
        "UPDATE token_image_cache SET " +
            "status = 'succeeded', attempts = @attempts, next_attempt_at = 0, cache_key = @cacheKey, " +
            "content_type = @contentType, source_bytes = @sourceBytes, cached_bytes = @cachedBytes, " +
            "width = @width, height = @height, relative_path = @relativePath, public_path = @publicPath, " +
            "last_error = NULL, last_error_at = NULL, updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = @runId AND token_id = @tokenId",
    );
    private markImageCacheTaskRetryStmt = db.prepare<{
        runId: number;
        tokenId: string;
        attempts: number;
        nextAttemptAt: number;
        lastError: string;
        failedTerminal: number;
        nowMs: number;
    }>(
        "UPDATE token_image_cache SET " +
            "status = CASE WHEN @failedTerminal = 1 THEN 'failed_terminal' ELSE 'retry' END, " +
            "attempts = @attempts, next_attempt_at = @nextAttemptAt, last_error = @lastError, last_error_at = @nowMs, updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = @runId AND token_id = @tokenId",
    );
    private selectImageCacheTaskCountsStmt = db.prepare<{ runId: number }>(
        "SELECT status, COUNT(*) AS count FROM token_image_cache " +
            "WHERE run_id = @runId GROUP BY status",
    );

    resetSnapshot(runId: number): void {
        this.resetSnapshotStmt.run({ runId });
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
                collectionId: params.collectionId,
            });
            this.insertBalancesFromSnapshotStmt.run({
                runId: params.runId,
                anchorBlock: params.anchorBlock,
                anchorHash: params.anchorHash,
                anchorTimestamp: params.anchorTimestamp,
                zeroHash: ZERO_HASH,
            });
        });
        finalize(input);
    }

    resetMetadataTasks(runId: number): void {
        this.resetMetadataTasksStmt.run({ runId });
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
        runId: number,
        nowMs: number,
        limit: number,
    ): BootstrapMetadataTask[] {
        const rows = this.selectMetadataTasksDueStmt.all({
            runId,
            nowMs,
            limit,
        }) as BootstrapMetadataTaskDbRow[];
        return rows.map(mapBootstrapMetadataTaskDbRow);
    }

    markMetadataTaskSucceeded(
        runId: number,
        tokenId: string,
        attempts: number,
    ): void {
        this.markMetadataTaskSucceededStmt.run({
            runId,
            tokenId,
            attempts,
        });
    }

    markMetadataTaskRetry(
        runId: number,
        tokenId: string,
        attempts: number,
        nextAttemptAt: number,
        lastError: string,
        failedTerminal: boolean,
    ): void {
        this.markMetadataTaskRetryStmt.run({
            runId,
            tokenId,
            attempts,
            nextAttemptAt,
            lastError,
            failedTerminal: failedTerminal ? 1 : 0,
            nowMs: Date.now(),
        });
    }

    getMetadataTaskCounts(runId: number): BootstrapMetadataTaskCounts {
        const counts: BootstrapMetadataTaskCounts = {
            pending: 0,
            retry: 0,
            succeeded: 0,
            failedTerminal: 0,
            total: 0,
        };
        const rows = this.selectMetadataTaskCountsStmt.all({
            runId,
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

    listMetadataTaskTokenIds(runId: number): string[] {
        const rows = this.selectMetadataTaskTokenIdsStmt.all({
            runId,
        }) as Array<{ token_id: string }>;
        return rows.map((row) => row.token_id);
    }

    resetImageCacheTasks(runId: number): void {
        this.resetImageCacheTasksStmt.run({ runId });
    }

    seedImageCacheTasks(input: {
        runId: number;
        requestedMaxDimension: number | null;
    }): number {
        const result = this.seedImageCacheTasksStmt.run(input);
        return result.changes;
    }

    listImageCacheTasksDueNow(
        runId: number,
        nowMs: number,
        limit: number,
    ): BootstrapImageCacheTask[] {
        const rows = this.selectImageCacheTasksDueStmt.all({
            runId,
            nowMs,
            limit,
        }) as BootstrapImageCacheTaskDbRow[];
        return rows.map(mapBootstrapImageCacheTaskDbRow);
    }

    markImageCacheTaskSucceeded(input: {
        runId: number;
        tokenId: string;
        attempts: number;
        cacheKey: string;
        contentType: string;
        sourceBytes: number;
        cachedBytes: number;
        width: number | null;
        height: number | null;
        relativePath: string;
        publicPath: string;
    }): void {
        this.markImageCacheTaskSucceededStmt.run(input);
    }

    markImageCacheTaskRetry(input: {
        runId: number;
        tokenId: string;
        attempts: number;
        nextAttemptAt: number;
        lastError: string;
        failedTerminal: boolean;
    }): void {
        this.markImageCacheTaskRetryStmt.run({
            ...input,
            failedTerminal: input.failedTerminal ? 1 : 0,
            nowMs: Date.now(),
        });
    }

    getImageCacheTaskCounts(runId: number): BootstrapImageCacheTaskCounts {
        const counts: BootstrapImageCacheTaskCounts = {
            pending: 0,
            retry: 0,
            succeeded: 0,
            failedTerminal: 0,
            total: 0,
        };
        const rows = this.selectImageCacheTaskCountsStmt.all({
            runId,
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
}

function mapBootstrapMetadataTaskDbRow(
    row: BootstrapMetadataTaskDbRow,
): BootstrapMetadataTask {
    return {
        runId: row.run_id,
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

function mapBootstrapImageCacheTaskDbRow(
    row: BootstrapImageCacheTaskDbRow,
): BootstrapImageCacheTask {
    return {
        runId: row.run_id,
        chainId: row.chain_id,
        collectionId: row.collection_id,
        contract: row.contract_address,
        tokenId: row.token_id,
        sourceImageUrl: row.source_image_url,
        requestedMaxDimension: row.requested_max_dimension,
        status: row.status,
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at,
    };
}
