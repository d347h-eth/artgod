import { db } from "@artgod/shared/database";
import type { CollectionExtensionKey } from "@artgod/shared/extensions";
import {
    BOOTSTRAP_TASK_STATUS,
    mapBootstrapTaskStatusCounts,
    type BootstrapTaskStatusCountRow,
} from "@artgod/shared/bootstrap/pipeline";
import type {
    BootstrapCollectionExtensionArtifactTask,
    BootstrapCollectionExtensionArtifactTaskCounts,
    BootstrapMetadataTask,
    BootstrapMetadataTaskCounts,
    BootstrapMetadataTaskSeed,
    BootstrapImageCacheTask,
    BootstrapImageCacheTaskCounts,
    BootstrapOwnershipTask,
    BootstrapOwnershipTaskCounts,
    BootstrapOwnershipTaskSeed,
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

type BootstrapOwnershipTaskDbRow = {
    run_id: number;
    chain_id: number;
    collection_id: number;
    contract_address: string;
    token_id: string;
    standard: BootstrapOwnershipTask["standard"];
    anchor_block: number;
    anchor_block_hash: string;
    anchor_block_timestamp: number;
    status: BootstrapOwnershipTask["status"];
    attempts: number;
    next_attempt_at: number;
};

type BootstrapCollectionExtensionArtifactTaskDbRow = {
    run_id: number;
    chain_id: number;
    collection_id: number;
    contract_address: string;
    token_id: string;
    extension_key: CollectionExtensionKey;
    status: BootstrapCollectionExtensionArtifactTask["status"];
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
    private deleteSucceededMetadataTasksStmt = db.prepare<{
        runId: number;
        succeededStatus: BootstrapMetadataTask["status"];
    }>(
        "DELETE FROM bootstrap_metadata_snapshot_tasks " +
            "WHERE run_id = @runId AND status = @succeededStatus",
    );
    private insertMetadataTaskStmt = db.prepare<
        BootstrapMetadataTaskSeed & { pendingStatus: BootstrapMetadataTask["status"] }
    >(
        "INSERT INTO bootstrap_metadata_snapshot_tasks " +
            "(run_id, chain_id, collection_id, contract_address, token_id, standard, anchor_block, anchor_block_hash, anchor_block_timestamp, status, attempts, next_attempt_at) " +
            "VALUES (@runId, @chainId, @collectionId, lower(@contract), @tokenId, @standard, @anchorBlock, @anchorHash, @anchorTimestamp, @pendingStatus, 0, 0)",
    );
    private selectMetadataTasksDueStmt = db.prepare<{
        runId: number;
        nowMs: number;
        limit: number;
        pendingStatus: BootstrapMetadataTask["status"];
        retryStatus: BootstrapMetadataTask["status"];
    }>(
        "SELECT run_id, chain_id, collection_id, contract_address, token_id, standard, anchor_block, anchor_block_hash, anchor_block_timestamp, status, attempts, next_attempt_at " +
            "FROM bootstrap_metadata_snapshot_tasks " +
            "WHERE run_id = @runId " +
            "AND status IN (@pendingStatus, @retryStatus) AND next_attempt_at <= @nowMs " +
            "ORDER BY next_attempt_at ASC, token_id ASC LIMIT @limit",
    );
    private markMetadataTaskSucceededStmt = db.prepare<{
        runId: number;
        tokenId: string;
        attempts: number;
        succeededStatus: BootstrapMetadataTask["status"];
    }>(
        "UPDATE bootstrap_metadata_snapshot_tasks SET " +
            "status = @succeededStatus, attempts = @attempts, last_error = NULL, last_error_at = NULL, updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = @runId AND token_id = @tokenId",
    );
    private markMetadataTaskRetryStmt = db.prepare<{
        runId: number;
        tokenId: string;
        attempts: number;
        nextAttemptAt: number;
        lastError: string;
        failedTerminal: number;
        retryStatus: BootstrapMetadataTask["status"];
        failedTerminalStatus: BootstrapMetadataTask["status"];
        nowMs: number;
    }>(
        "UPDATE bootstrap_metadata_snapshot_tasks SET " +
            "status = CASE WHEN @failedTerminal = 1 THEN @failedTerminalStatus ELSE @retryStatus END, " +
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
        "DELETE FROM bootstrap_image_cache_tasks WHERE run_id = @runId",
    );
    private deleteSucceededImageCacheTasksStmt = db.prepare<{
        runId: number;
        succeededStatus: BootstrapImageCacheTask["status"];
    }>(
        "DELETE FROM bootstrap_image_cache_tasks " +
            "WHERE run_id = @runId AND status = @succeededStatus",
    );
    private seedImageCacheTasksStmt = db.prepare<{
        runId: number;
        requestedMaxDimension: number | null;
        pendingStatus: BootstrapImageCacheTask["status"];
        succeededStatus: BootstrapMetadataTask["status"];
    }>(
        "INSERT INTO bootstrap_image_cache_tasks " +
            "(run_id, chain_id, collection_id, contract_address, token_id, source_image_url, requested_max_dimension, status, attempts, next_attempt_at, cache_key, content_type, source_bytes, cached_bytes, width, height, relative_path, public_path, last_error, last_error_at) " +
            "SELECT t.run_id, t.chain_id, t.collection_id, lower(t.contract_address), t.token_id, m.image, @requestedMaxDimension, @pendingStatus, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL " +
            "FROM bootstrap_metadata_snapshot_tasks t " +
            "JOIN token_metadata m ON m.chain_id = t.chain_id " +
            "AND m.collection_id = t.collection_id " +
            "AND m.token_id = t.token_id " +
            "WHERE t.run_id = @runId AND t.status = @succeededStatus " +
            "AND m.image IS NOT NULL AND trim(m.image) <> '' " +
            "ON CONFLICT(run_id, token_id) DO UPDATE SET " +
            "chain_id = excluded.chain_id, collection_id = excluded.collection_id, contract_address = excluded.contract_address, " +
            "source_image_url = excluded.source_image_url, requested_max_dimension = excluded.requested_max_dimension, " +
            "status = @pendingStatus, attempts = 0, next_attempt_at = 0, cache_key = NULL, content_type = NULL, " +
            "source_bytes = NULL, cached_bytes = NULL, width = NULL, height = NULL, relative_path = NULL, public_path = NULL, " +
            "last_error = NULL, last_error_at = NULL, " +
            "updated_at = CURRENT_TIMESTAMP",
    );
    private selectImageCacheTasksDueStmt = db.prepare<{
        runId: number;
        nowMs: number;
        limit: number;
        pendingStatus: BootstrapImageCacheTask["status"];
        retryStatus: BootstrapImageCacheTask["status"];
    }>(
        "SELECT run_id, chain_id, collection_id, contract_address, token_id, source_image_url, requested_max_dimension, status, attempts, next_attempt_at " +
            "FROM bootstrap_image_cache_tasks " +
            "WHERE run_id = @runId " +
            "AND status IN (@pendingStatus, @retryStatus) AND next_attempt_at <= @nowMs " +
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
        succeededStatus: BootstrapImageCacheTask["status"];
    }>(
        "UPDATE bootstrap_image_cache_tasks SET " +
            "status = @succeededStatus, attempts = @attempts, next_attempt_at = 0, cache_key = @cacheKey, " +
            "content_type = @contentType, source_bytes = @sourceBytes, cached_bytes = @cachedBytes, " +
            "width = @width, height = @height, relative_path = @relativePath, public_path = @publicPath, " +
            "last_error = NULL, last_error_at = NULL, updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = @runId AND token_id = @tokenId",
    );
    private upsertSettledImageCacheStmt = db.prepare<{
        runId: number;
        tokenId: string;
        cacheKey: string;
        contentType: string;
        sourceBytes: number;
        cachedBytes: number;
        width: number | null;
        height: number | null;
        relativePath: string;
        publicPath: string;
    }>(
        "INSERT INTO token_image_cache " +
            "(chain_id, collection_id, token_id, source_image_url, requested_max_dimension, cache_key, content_type, source_bytes, cached_bytes, width, height, relative_path, public_path) " +
            "SELECT chain_id, collection_id, token_id, source_image_url, requested_max_dimension, @cacheKey, @contentType, @sourceBytes, @cachedBytes, @width, @height, @relativePath, @publicPath " +
            "FROM bootstrap_image_cache_tasks WHERE run_id = @runId AND token_id = @tokenId " +
            "ON CONFLICT(chain_id, collection_id, token_id) DO UPDATE SET " +
            "source_image_url = excluded.source_image_url, requested_max_dimension = excluded.requested_max_dimension, " +
            "cache_key = excluded.cache_key, content_type = excluded.content_type, source_bytes = excluded.source_bytes, " +
            "cached_bytes = excluded.cached_bytes, width = excluded.width, height = excluded.height, " +
            "relative_path = excluded.relative_path, public_path = excluded.public_path, updated_at = CURRENT_TIMESTAMP",
    );
    private markImageCacheTaskRetryStmt = db.prepare<{
        runId: number;
        tokenId: string;
        attempts: number;
        nextAttemptAt: number;
        lastError: string;
        failedTerminal: number;
        retryStatus: BootstrapImageCacheTask["status"];
        failedTerminalStatus: BootstrapImageCacheTask["status"];
        nowMs: number;
    }>(
        "UPDATE bootstrap_image_cache_tasks SET " +
            "status = CASE WHEN @failedTerminal = 1 THEN @failedTerminalStatus ELSE @retryStatus END, " +
            "attempts = @attempts, next_attempt_at = @nextAttemptAt, last_error = @lastError, last_error_at = @nowMs, updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = @runId AND token_id = @tokenId",
    );
    private selectImageCacheTaskCountsStmt = db.prepare<{ runId: number }>(
        "SELECT status, COUNT(*) AS count FROM bootstrap_image_cache_tasks " +
            "WHERE run_id = @runId GROUP BY status",
    );
    private resetOwnershipTasksStmt = db.prepare<{ runId: number }>(
        "DELETE FROM bootstrap_ownership_snapshot_tasks WHERE run_id = @runId",
    );
    private deleteSucceededOwnershipTasksStmt = db.prepare<{
        runId: number;
        succeededStatus: BootstrapOwnershipTask["status"];
    }>(
        "DELETE FROM bootstrap_ownership_snapshot_tasks " +
            "WHERE run_id = @runId AND status = @succeededStatus",
    );
    private insertOwnershipTaskStmt = db.prepare<
        BootstrapOwnershipTaskSeed & {
            pendingStatus: BootstrapOwnershipTask["status"];
        }
    >(
        "INSERT INTO bootstrap_ownership_snapshot_tasks " +
            "(run_id, chain_id, collection_id, contract_address, token_id, standard, anchor_block, anchor_block_hash, anchor_block_timestamp, status, attempts, next_attempt_at) " +
            "VALUES (@runId, @chainId, @collectionId, lower(@contract), @tokenId, @standard, @anchorBlock, @anchorHash, @anchorTimestamp, @pendingStatus, 0, 0) " +
            "ON CONFLICT(run_id, token_id) DO UPDATE SET " +
            "chain_id = excluded.chain_id, collection_id = excluded.collection_id, contract_address = excluded.contract_address, " +
            "standard = excluded.standard, anchor_block = excluded.anchor_block, anchor_block_hash = excluded.anchor_block_hash, " +
            "anchor_block_timestamp = excluded.anchor_block_timestamp, status = @pendingStatus, attempts = 0, next_attempt_at = 0, " +
            "last_error = NULL, last_error_at = NULL, updated_at = CURRENT_TIMESTAMP",
    );
    private selectOwnershipTasksDueStmt = db.prepare<{
        runId: number;
        nowMs: number;
        limit: number;
        pendingStatus: BootstrapOwnershipTask["status"];
        retryStatus: BootstrapOwnershipTask["status"];
    }>(
        "SELECT run_id, chain_id, collection_id, contract_address, token_id, standard, anchor_block, anchor_block_hash, anchor_block_timestamp, status, attempts, next_attempt_at " +
            "FROM bootstrap_ownership_snapshot_tasks " +
            "WHERE run_id = @runId " +
            "AND status IN (@pendingStatus, @retryStatus) AND next_attempt_at <= @nowMs " +
            "ORDER BY next_attempt_at ASC, token_id ASC LIMIT @limit",
    );
    private markOwnershipTaskSucceededStmt = db.prepare<{
        runId: number;
        tokenId: string;
        attempts: number;
        succeededStatus: BootstrapOwnershipTask["status"];
    }>(
        "UPDATE bootstrap_ownership_snapshot_tasks SET " +
            "status = @succeededStatus, attempts = @attempts, next_attempt_at = 0, " +
            "last_error = NULL, last_error_at = NULL, updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = @runId AND token_id = @tokenId",
    );
    private insertSnapshotFromOwnershipTaskStmt = db.prepare<{
        runId: number;
        tokenId: string;
        owner: string;
    }>(
        "INSERT INTO nft_balance_snapshots " +
            "(run_id, chain_id, collection_id, contract_address, token_id, owner, anchor_block) " +
            "SELECT run_id, chain_id, collection_id, lower(contract_address), token_id, lower(@owner), anchor_block " +
            "FROM bootstrap_ownership_snapshot_tasks WHERE run_id = @runId AND token_id = @tokenId " +
            "ON CONFLICT(run_id, collection_id, token_id, owner) DO UPDATE SET owner = excluded.owner",
    );
    private deleteSnapshotTokenStmt = db.prepare<{
        runId: number;
        tokenId: string;
    }>(
        "DELETE FROM nft_balance_snapshots WHERE run_id = @runId AND token_id = @tokenId",
    );
    private markOwnershipTaskRetryStmt = db.prepare<{
        runId: number;
        tokenId: string;
        attempts: number;
        nextAttemptAt: number;
        lastError: string;
        failedTerminal: number;
        retryStatus: BootstrapOwnershipTask["status"];
        failedTerminalStatus: BootstrapOwnershipTask["status"];
        nowMs: number;
    }>(
        "UPDATE bootstrap_ownership_snapshot_tasks SET " +
            "status = CASE WHEN @failedTerminal = 1 THEN @failedTerminalStatus ELSE @retryStatus END, " +
            "attempts = @attempts, next_attempt_at = @nextAttemptAt, last_error = @lastError, last_error_at = @nowMs, updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = @runId AND token_id = @tokenId",
    );
    private selectOwnershipTaskCountsStmt = db.prepare<{ runId: number }>(
        "SELECT status, COUNT(*) AS count FROM bootstrap_ownership_snapshot_tasks " +
            "WHERE run_id = @runId GROUP BY status",
    );
    private seedCollectionExtensionArtifactTasksStmt = db.prepare<{
        runId: number;
        extensionKey: CollectionExtensionKey;
        pendingStatus: BootstrapCollectionExtensionArtifactTask["status"];
        succeededStatus: BootstrapMetadataTask["status"];
    }>(
        "INSERT INTO bootstrap_collection_extension_artifact_tasks " +
            "(run_id, chain_id, collection_id, contract_address, token_id, extension_key, status, attempts, next_attempt_at, last_error, last_error_at) " +
            "SELECT run_id, chain_id, collection_id, lower(contract_address), token_id, @extensionKey, @pendingStatus, 0, 0, NULL, NULL " +
            "FROM bootstrap_metadata_snapshot_tasks " +
            "WHERE run_id = @runId AND status = @succeededStatus " +
            "ON CONFLICT(run_id, token_id, extension_key) DO UPDATE SET " +
            "chain_id = excluded.chain_id, collection_id = excluded.collection_id, contract_address = excluded.contract_address, " +
            "status = @pendingStatus, attempts = 0, next_attempt_at = 0, last_error = NULL, last_error_at = NULL, " +
            "updated_at = CURRENT_TIMESTAMP",
    );
    private selectCollectionExtensionArtifactTasksDueStmt = db.prepare<{
        runId: number;
        nowMs: number;
        limit: number;
        pendingStatus: BootstrapCollectionExtensionArtifactTask["status"];
        retryStatus: BootstrapCollectionExtensionArtifactTask["status"];
    }>(
        "SELECT run_id, chain_id, collection_id, contract_address, token_id, extension_key, status, attempts, next_attempt_at " +
            "FROM bootstrap_collection_extension_artifact_tasks " +
            "WHERE run_id = @runId " +
            "AND status IN (@pendingStatus, @retryStatus) AND next_attempt_at <= @nowMs " +
            "ORDER BY next_attempt_at ASC, token_id ASC LIMIT @limit",
    );
    private selectCollectionExtensionArtifactTasksToPublishStmt = db.prepare<{
        runId: number;
        cursorTokenId: string | null;
        limit: number;
        pendingStatus: BootstrapCollectionExtensionArtifactTask["status"];
        retryStatus: BootstrapCollectionExtensionArtifactTask["status"];
    }>(
        "SELECT run_id, chain_id, collection_id, contract_address, token_id, extension_key, status, attempts, next_attempt_at " +
            "FROM bootstrap_collection_extension_artifact_tasks " +
            "WHERE run_id = @runId " +
            "AND status IN (@pendingStatus, @retryStatus) " +
            "AND (@cursorTokenId IS NULL OR token_id > @cursorTokenId) " +
            "ORDER BY token_id ASC LIMIT @limit",
    );
    private selectCollectionExtensionArtifactTaskStmt = db.prepare<{
        runId: number;
        tokenId: string;
        extensionKey: CollectionExtensionKey;
    }>(
        "SELECT run_id, chain_id, collection_id, contract_address, token_id, extension_key, status, attempts, next_attempt_at " +
            "FROM bootstrap_collection_extension_artifact_tasks " +
            "WHERE run_id = @runId AND token_id = @tokenId AND extension_key = @extensionKey LIMIT 1",
    );
    private markCollectionExtensionArtifactTaskSucceededStmt = db.prepare<{
        runId: number;
        tokenId: string;
        extensionKey: CollectionExtensionKey;
        attempts: number;
        succeededStatus: BootstrapCollectionExtensionArtifactTask["status"];
    }>(
        "UPDATE bootstrap_collection_extension_artifact_tasks SET " +
            "status = @succeededStatus, attempts = @attempts, next_attempt_at = 0, " +
            "last_error = NULL, last_error_at = NULL, updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = @runId AND token_id = @tokenId AND extension_key = @extensionKey",
    );
    private markCollectionExtensionArtifactTaskRetryStmt = db.prepare<{
        runId: number;
        tokenId: string;
        extensionKey: CollectionExtensionKey;
        attempts: number;
        nextAttemptAt: number;
        lastError: string;
        failedTerminal: number;
        retryStatus: BootstrapCollectionExtensionArtifactTask["status"];
        failedTerminalStatus: BootstrapCollectionExtensionArtifactTask["status"];
        nowMs: number;
    }>(
        "UPDATE bootstrap_collection_extension_artifact_tasks SET " +
            "status = CASE WHEN @failedTerminal = 1 THEN @failedTerminalStatus ELSE @retryStatus END, " +
            "attempts = @attempts, next_attempt_at = @nextAttemptAt, last_error = @lastError, last_error_at = @nowMs, updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = @runId AND token_id = @tokenId AND extension_key = @extensionKey",
    );
    private selectCollectionExtensionArtifactTaskCountsStmt = db.prepare<{
        runId: number;
    }>(
        "SELECT status, COUNT(*) AS count FROM bootstrap_collection_extension_artifact_tasks " +
            "WHERE run_id = @runId GROUP BY status",
    );
    private resetCollectionExtensionArtifactTasksStmt = db.prepare<{
        runId: number;
    }>(
        "DELETE FROM bootstrap_collection_extension_artifact_tasks " +
            "WHERE run_id = @runId",
    );
    private deleteSucceededCollectionExtensionArtifactTasksStmt = db.prepare<{
        runId: number;
        succeededStatus: BootstrapCollectionExtensionArtifactTask["status"];
    }>(
        "DELETE FROM bootstrap_collection_extension_artifact_tasks " +
            "WHERE run_id = @runId AND status = @succeededStatus",
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

    deleteRunTemporaryData(runId: number): void {
        const cleanup = db.raw.transaction((targetRunId: number) => {
            this.resetMetadataTasksStmt.run({ runId: targetRunId });
            this.resetImageCacheTasksStmt.run({ runId: targetRunId });
            this.resetOwnershipTasksStmt.run({ runId: targetRunId });
            this.resetCollectionExtensionArtifactTasksStmt.run({
                runId: targetRunId,
            });
            this.resetSnapshotStmt.run({ runId: targetRunId });
        });
        cleanup(runId);
    }

    deleteSnapshotRows(runId: number): number {
        return this.resetSnapshotStmt.run({ runId }).changes;
    }

    resetMetadataTasks(runId: number): void {
        this.resetMetadataTasksStmt.run({ runId });
    }

    deleteSucceededMetadataTasks(runId: number): number {
        return this.deleteSucceededMetadataTasksStmt.run({
            runId,
            succeededStatus: BOOTSTRAP_TASK_STATUS.Succeeded,
        }).changes;
    }

    insertMetadataTasks(rows: BootstrapMetadataTaskSeed[]): void {
        if (rows.length === 0) return;
        const insertMany = db.raw.transaction(
            (batch: BootstrapMetadataTaskSeed[]) => {
                for (const row of batch) {
                    this.insertMetadataTaskStmt.run({
                        ...row,
                        pendingStatus: BOOTSTRAP_TASK_STATUS.Pending,
                    });
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
            pendingStatus: BOOTSTRAP_TASK_STATUS.Pending,
            retryStatus: BOOTSTRAP_TASK_STATUS.Retry,
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
            succeededStatus: BOOTSTRAP_TASK_STATUS.Succeeded,
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
            retryStatus: BOOTSTRAP_TASK_STATUS.Retry,
            failedTerminalStatus: BOOTSTRAP_TASK_STATUS.FailedTerminal,
            nowMs: Date.now(),
        });
    }

    getMetadataTaskCounts(runId: number): BootstrapMetadataTaskCounts {
        const rows = this.selectMetadataTaskCountsStmt.all({
            runId,
        }) as BootstrapTaskStatusCountRow[];
        return mapBootstrapTaskStatusCounts(rows);
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

    deleteSucceededImageCacheTasks(runId: number): number {
        return this.deleteSucceededImageCacheTasksStmt.run({
            runId,
            succeededStatus: BOOTSTRAP_TASK_STATUS.Succeeded,
        }).changes;
    }

    seedImageCacheTasks(input: {
        runId: number;
        requestedMaxDimension: number | null;
    }): number {
        const result = this.seedImageCacheTasksStmt.run({
            ...input,
            pendingStatus: BOOTSTRAP_TASK_STATUS.Pending,
            succeededStatus: BOOTSTRAP_TASK_STATUS.Succeeded,
        });
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
            pendingStatus: BOOTSTRAP_TASK_STATUS.Pending,
            retryStatus: BOOTSTRAP_TASK_STATUS.Retry,
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
        const applySuccess = db.raw.transaction(
            (params: typeof input) => {
                this.markImageCacheTaskSucceededStmt.run({
                    ...params,
                    succeededStatus: BOOTSTRAP_TASK_STATUS.Succeeded,
                });
                this.upsertSettledImageCacheStmt.run(params);
            },
        );
        applySuccess(input);
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
            retryStatus: BOOTSTRAP_TASK_STATUS.Retry,
            failedTerminalStatus: BOOTSTRAP_TASK_STATUS.FailedTerminal,
            nowMs: Date.now(),
        });
    }

    getImageCacheTaskCounts(runId: number): BootstrapImageCacheTaskCounts {
        const rows = this.selectImageCacheTaskCountsStmt.all({
            runId,
        }) as BootstrapTaskStatusCountRow[];
        return mapBootstrapTaskStatusCounts(rows);
    }

    resetOwnershipTasks(runId: number): void {
        this.resetOwnershipTasksStmt.run({ runId });
    }

    deleteSucceededOwnershipTasks(runId: number): number {
        return this.deleteSucceededOwnershipTasksStmt.run({
            runId,
            succeededStatus: BOOTSTRAP_TASK_STATUS.Succeeded,
        }).changes;
    }

    insertOwnershipTasks(rows: BootstrapOwnershipTaskSeed[]): void {
        if (rows.length === 0) return;
        const insertMany = db.raw.transaction(
            (batch: BootstrapOwnershipTaskSeed[]) => {
                for (const row of batch) {
                    this.insertOwnershipTaskStmt.run({
                        ...row,
                        pendingStatus: BOOTSTRAP_TASK_STATUS.Pending,
                    });
                }
            },
        );
        insertMany(rows);
    }

    listOwnershipTasksDueNow(
        runId: number,
        nowMs: number,
        limit: number,
    ): BootstrapOwnershipTask[] {
        const rows = this.selectOwnershipTasksDueStmt.all({
            runId,
            nowMs,
            limit,
            pendingStatus: BOOTSTRAP_TASK_STATUS.Pending,
            retryStatus: BOOTSTRAP_TASK_STATUS.Retry,
        }) as BootstrapOwnershipTaskDbRow[];
        return rows.map(mapBootstrapOwnershipTaskDbRow);
    }

    markOwnershipTaskSucceeded(input: {
        runId: number;
        tokenId: string;
        attempts: number;
        owner: string;
    }): void {
        const applySuccess = db.raw.transaction((params: typeof input) => {
            this.deleteSnapshotTokenStmt.run({
                runId: params.runId,
                tokenId: params.tokenId,
            });
            this.insertSnapshotFromOwnershipTaskStmt.run({
                runId: params.runId,
                tokenId: params.tokenId,
                owner: params.owner,
            });
            this.markOwnershipTaskSucceededStmt.run({
                runId: params.runId,
                tokenId: params.tokenId,
                attempts: params.attempts,
                succeededStatus: BOOTSTRAP_TASK_STATUS.Succeeded,
            });
        });
        applySuccess(input);
    }

    markOwnershipTaskRetry(input: {
        runId: number;
        tokenId: string;
        attempts: number;
        nextAttemptAt: number;
        lastError: string;
        failedTerminal: boolean;
    }): void {
        this.markOwnershipTaskRetryStmt.run({
            ...input,
            failedTerminal: input.failedTerminal ? 1 : 0,
            retryStatus: BOOTSTRAP_TASK_STATUS.Retry,
            failedTerminalStatus: BOOTSTRAP_TASK_STATUS.FailedTerminal,
            nowMs: Date.now(),
        });
    }

    getOwnershipTaskCounts(runId: number): BootstrapOwnershipTaskCounts {
        const rows = this.selectOwnershipTaskCountsStmt.all({
            runId,
        }) as BootstrapTaskStatusCountRow[];
        return mapBootstrapTaskStatusCounts(rows);
    }

    deleteSucceededCollectionExtensionArtifactTasks(runId: number): number {
        return this.deleteSucceededCollectionExtensionArtifactTasksStmt.run({
            runId,
            succeededStatus: BOOTSTRAP_TASK_STATUS.Succeeded,
        }).changes;
    }

    seedCollectionExtensionArtifactTasks(input: {
        runId: number;
        extensionKey: CollectionExtensionKey;
    }): number {
        const result = this.seedCollectionExtensionArtifactTasksStmt.run({
            ...input,
            pendingStatus: BOOTSTRAP_TASK_STATUS.Pending,
            succeededStatus: BOOTSTRAP_TASK_STATUS.Succeeded,
        });
        return result.changes;
    }

    listCollectionExtensionArtifactTasksDueNow(
        runId: number,
        nowMs: number,
        limit: number,
    ): BootstrapCollectionExtensionArtifactTask[] {
        const rows = this.selectCollectionExtensionArtifactTasksDueStmt.all({
            runId,
            nowMs,
            limit,
            pendingStatus: BOOTSTRAP_TASK_STATUS.Pending,
            retryStatus: BOOTSTRAP_TASK_STATUS.Retry,
        }) as BootstrapCollectionExtensionArtifactTaskDbRow[];
        return rows.map(mapBootstrapCollectionExtensionArtifactTaskDbRow);
    }

    listCollectionExtensionArtifactTasksToPublish(
        runId: number,
        cursorTokenId: string | null,
        limit: number,
    ): BootstrapCollectionExtensionArtifactTask[] {
        const rows = this.selectCollectionExtensionArtifactTasksToPublishStmt.all({
            runId,
            cursorTokenId,
            limit,
            pendingStatus: BOOTSTRAP_TASK_STATUS.Pending,
            retryStatus: BOOTSTRAP_TASK_STATUS.Retry,
        }) as BootstrapCollectionExtensionArtifactTaskDbRow[];
        return rows.map(mapBootstrapCollectionExtensionArtifactTaskDbRow);
    }

    getCollectionExtensionArtifactTask(input: {
        runId: number;
        tokenId: string;
        extensionKey: CollectionExtensionKey;
    }): BootstrapCollectionExtensionArtifactTask | null {
        const row = this.selectCollectionExtensionArtifactTaskStmt.get(
            input,
        ) as BootstrapCollectionExtensionArtifactTaskDbRow | undefined;
        return row ? mapBootstrapCollectionExtensionArtifactTaskDbRow(row) : null;
    }

    markCollectionExtensionArtifactTaskSucceeded(input: {
        runId: number;
        tokenId: string;
        extensionKey: CollectionExtensionKey;
        attempts: number;
    }): void {
        this.markCollectionExtensionArtifactTaskSucceededStmt.run({
            ...input,
            succeededStatus: BOOTSTRAP_TASK_STATUS.Succeeded,
        });
    }

    markCollectionExtensionArtifactTaskRetry(input: {
        runId: number;
        tokenId: string;
        extensionKey: CollectionExtensionKey;
        attempts: number;
        nextAttemptAt: number;
        lastError: string;
        failedTerminal: boolean;
    }): void {
        this.markCollectionExtensionArtifactTaskRetryStmt.run({
            ...input,
            failedTerminal: input.failedTerminal ? 1 : 0,
            retryStatus: BOOTSTRAP_TASK_STATUS.Retry,
            failedTerminalStatus: BOOTSTRAP_TASK_STATUS.FailedTerminal,
            nowMs: Date.now(),
        });
    }

    getCollectionExtensionArtifactTaskCounts(
        runId: number,
    ): BootstrapCollectionExtensionArtifactTaskCounts {
        const rows = this.selectCollectionExtensionArtifactTaskCountsStmt.all({
            runId,
        }) as BootstrapTaskStatusCountRow[];
        return mapBootstrapTaskStatusCounts(rows);
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

function mapBootstrapOwnershipTaskDbRow(
    row: BootstrapOwnershipTaskDbRow,
): BootstrapOwnershipTask {
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

function mapBootstrapCollectionExtensionArtifactTaskDbRow(
    row: BootstrapCollectionExtensionArtifactTaskDbRow,
): BootstrapCollectionExtensionArtifactTask {
    return {
        runId: row.run_id,
        chainId: row.chain_id,
        collectionId: row.collection_id,
        contract: row.contract_address,
        tokenId: row.token_id,
        extensionKey: row.extension_key,
        status: row.status,
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at,
    };
}
