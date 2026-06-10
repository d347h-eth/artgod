import { db } from "@artgod/shared/database";
import type { CollectionExtensionKey } from "@artgod/shared/extensions";
import {
    IMAGE_CACHE_MODE,
    type ImageCacheMode,
} from "@artgod/shared/media/token-image-cache";
import {
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_STATUS,
    BOOTSTRAP_TASK_STATUS,
    mapBootstrapTaskStatusCounts,
    serializeBootstrapStepDependencies,
    type BootstrapRunStatus,
    type BootstrapRunStepPlan,
    type BootstrapTaskStatusCountRow,
} from "@artgod/shared/bootstrap/pipeline";
import {
    normalizeAddressRef,
    normalizeSlugRef,
} from "@artgod/shared/utils/ref-resolver";
import type {
    BootstrapRunsWritePort,
    CollectionBootstrapState,
} from "../../application/use-cases/bootstrap/ports.js";
import type {
    BootstrapRunEventRecord,
    BootstrapMetadataTaskListItem,
    BootstrapMetadataTaskStatus,
    BootstrapRunRow,
    BootstrapRunStepRecord,
    BootstrapRunTaskCounts,
} from "../../application/use-cases/bootstrap/types.js";

type CollectionRow = {
    chain_id: number;
    collection_id: number;
    slug: string;
    address: string;
    standard: string;
    status: BootstrapRunStatus;
    token_scope_kind:
        | "contract_all_tokens"
        | "token_range"
        | "explicit_token_ids";
    scope_start_token_id: string | null;
    scope_total_supply: number | null;
    deployment_block: number | null;
    bootstrap_anchor_block: number | null;
    bootstrap_started_at: string | null;
    bootstrap_finished_at: string | null;
    bootstrap_last_synced_block: number | null;
    opensea_slug: string | null;
    opensea_status:
        | "pending"
        | "identity_running"
        | "subscribing"
        | "snapshot_pending"
        | "snapshot_running"
        | "ready"
        | "retrying"
        | "failed"
        | null;
    opensea_ready_at: string | null;
    opensea_snapshot_started_at: string | null;
    opensea_snapshot_completed_at: string | null;
    opensea_last_error: string | null;
};

type BootstrapRunDbRow = {
    run_id: number;
    chain_id: number;
    collection_id: number;
    request_slug: string;
    request_opensea_slug: string | null;
    request_address: string;
    request_standard: string;
    request_extension_key: CollectionExtensionKey | null;
    metadata_mode: "strict" | "best_effort";
    enumeration_mode: "enumerable" | "manual_token_ids" | "manual_range";
    manual_token_ids_json: string | null;
    manual_range_start_token_id: string | null;
    manual_range_total_supply: number | null;
    request_image_cache_mode: ImageCacheMode;
    request_image_cache_max_dimension: number | null;
    deployment_block: number | null;
    status: BootstrapRunStatus;
    anchor_block: number | null;
    anchor_block_hash: string | null;
    anchor_block_timestamp: number | null;
    error_code: string | null;
    error_message: string | null;
    created_at: string;
    updated_at: string;
    finished_at: string | null;
};

type BootstrapTaskDbRow = {
    token_id: string;
    status: BootstrapMetadataTaskStatus;
    attempts: number;
    next_attempt_at: number;
    last_error: string | null;
    last_error_at: number | null;
};

type BootstrapRunEventDbRow = {
    event_code: string;
    event_level: "info" | "warn" | "error";
    message: string;
    created_at: string;
    payload_json: string | null;
};

type BootstrapTaskCountRow = {
    status: string;
    count: number;
};

type BootstrapRunStepDbRow = {
    run_id: number;
    step_key: BootstrapRunStepRecord["stepKey"];
    status: BootstrapRunStepRecord["status"];
    blocking: number;
    progress_completed: number;
    progress_total: number | null;
    last_error: string | null;
    config_json: string | null;
};

const COLLECTION_COLUMNS =
    "chain_id, collection_id, slug, address, standard, status, token_scope_kind, scope_start_token_id, scope_total_supply, deployment_block, bootstrap_anchor_block, bootstrap_started_at, bootstrap_finished_at, bootstrap_last_synced_block, opensea_slug, opensea_status, opensea_ready_at, opensea_snapshot_started_at, opensea_snapshot_completed_at, opensea_last_error";

export class SqliteBootstrapRunsRepository implements BootstrapRunsWritePort {
    private selectCollectionBySlug = db.prepare<{
        chainId: number;
        slug: string;
    }>(
        `SELECT ${COLLECTION_COLUMNS} ` +
            "FROM collections WHERE chain_id = @chainId AND slug = @slug LIMIT 1",
    );

    private selectCollectionsByAddress = db.prepare<{
        chainId: number;
        address: string;
    }>(
        `SELECT ${COLLECTION_COLUMNS} ` +
            "FROM collections WHERE chain_id = @chainId AND lower(address) = @address ORDER BY collection_id ASC",
    );

    private selectCollectionById = db.prepare<{
        chainId: number;
        collectionId: number;
    }>(
        `SELECT ${COLLECTION_COLUMNS} ` +
            "FROM collections WHERE chain_id = @chainId AND collection_id = @collectionId LIMIT 1",
    );

    private upsertCollectionBySlug = db.prepare<{
        chainId: number;
        slug: string;
        address: string;
        openseaSlug: string | null;
        standard: string;
        tokenScopeKind:
            | "contract_all_tokens"
            | "token_range"
            | "explicit_token_ids";
        scopeStartTokenId: string | null;
        scopeTotalSupply: number | null;
        deploymentBlock: number | null;
    }>(
        "INSERT INTO collections " +
            "(chain_id, slug, address, standard, status, token_scope_kind, scope_start_token_id, scope_total_supply, deployment_block, bootstrap_anchor_block, bootstrap_started_at, bootstrap_finished_at, bootstrap_last_synced_block, opensea_slug) " +
            "VALUES (@chainId, @slug, @address, @standard, 'bootstrapping', @tokenScopeKind, @scopeStartTokenId, @scopeTotalSupply, @deploymentBlock, NULL, NULL, NULL, NULL, @openseaSlug) " +
            "ON CONFLICT(chain_id, slug) DO UPDATE SET " +
            "address = excluded.address, standard = excluded.standard, status = 'bootstrapping', " +
            "token_scope_kind = excluded.token_scope_kind, " +
            "scope_start_token_id = excluded.scope_start_token_id, " +
            "scope_total_supply = excluded.scope_total_supply, " +
            "deployment_block = COALESCE(excluded.deployment_block, collections.deployment_block), " +
            "opensea_slug = excluded.opensea_slug, " +
            "bootstrap_finished_at = NULL, updated_at = CURRENT_TIMESTAMP",
    );

    private deleteCollectionScopeTokens = db.prepare<{
        chainId: number;
        collectionId: number;
    }>(
        "DELETE FROM collection_scope_tokens WHERE chain_id = @chainId AND collection_id = @collectionId",
    );

    private insertCollectionScopeToken = db.prepare<{
        chainId: number;
        collectionId: number;
        tokenId: string;
    }>(
        "INSERT INTO collection_scope_tokens (chain_id, collection_id, token_id) VALUES (@chainId, @collectionId, @tokenId)",
    );

    private selectCollectionScopeTokens = db.prepare<{
        chainId: number;
        collectionId: number;
    }>(
        "SELECT token_id FROM collection_scope_tokens WHERE chain_id = @chainId AND collection_id = @collectionId ORDER BY token_id ASC",
    );

    private selectActiveRunCount = db.prepare<{
        chainId: number;
        collectionId: number;
        requestedStatus: BootstrapRunStatus;
        queuedStatus: BootstrapRunStatus;
        metadataStatus: BootstrapRunStatus;
        imageCacheStatus: BootstrapRunStatus;
        ownershipStatus: BootstrapRunStatus;
        backfillStatus: BootstrapRunStatus;
    }>(
        "SELECT COUNT(*) AS count FROM bootstrap_runs " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId " +
            "AND status IN (@requestedStatus, @queuedStatus, @metadataStatus, @imageCacheStatus, @ownershipStatus, @backfillStatus)",
    );

    private insertRun = db.prepare<{
        chainId: number;
        collectionId: number;
        requestSlug: string;
        requestOpenseaSlug: string | null;
        requestAddress: string;
        requestStandard: string;
        requestExtensionKey: CollectionExtensionKey | null;
        metadataMode: string;
        enumerationMode: string;
        manualTokenIdsJson: string | null;
        manualRangeStartTokenId: string | null;
        manualRangeTotalSupply: number | null;
        imageCacheMode: ImageCacheMode;
        imageCacheMaxDimension: number | null;
        deploymentBlock: number | null;
        requestedStatus: BootstrapRunStatus;
    }>(
        "INSERT INTO bootstrap_runs " +
            "(chain_id, collection_id, request_slug, request_opensea_slug, request_address, request_standard, request_extension_key, metadata_mode, enumeration_mode, manual_token_ids_json, manual_range_start_token_id, manual_range_total_supply, request_image_cache_mode, request_image_cache_max_dimension, deployment_block, status) " +
            "VALUES (@chainId, @collectionId, @requestSlug, @requestOpenseaSlug, @requestAddress, @requestStandard, @requestExtensionKey, @metadataMode, @enumerationMode, @manualTokenIdsJson, @manualRangeStartTokenId, @manualRangeTotalSupply, @imageCacheMode, @imageCacheMaxDimension, @deploymentBlock, @requestedStatus)",
    );

    private insertRunStep = db.prepare<{
        runId: number;
        stepKey: string;
        status: string;
        blocking: number;
        dependsOnJson: string;
        progressTotal: number | null;
        configJson: string | null;
    }>(
        "INSERT INTO bootstrap_run_steps " +
            "(run_id, step_key, status, blocking, depends_on_json, progress_total, config_json) " +
            "VALUES (@runId, @stepKey, @status, @blocking, @dependsOnJson, @progressTotal, @configJson)",
    );

    private selectLatestRun = db.prepare<{
        chainId: number;
        collectionId: number;
    }>(
        "SELECT run_id, chain_id, collection_id, request_slug, request_opensea_slug, request_address, request_standard, request_extension_key, metadata_mode, enumeration_mode, manual_token_ids_json, manual_range_start_token_id, manual_range_total_supply, request_image_cache_mode, request_image_cache_max_dimension, deployment_block, status, anchor_block, anchor_block_hash, anchor_block_timestamp, error_code, error_message, created_at, updated_at, finished_at " +
            "FROM bootstrap_runs WHERE chain_id = @chainId AND collection_id = @collectionId ORDER BY run_id DESC LIMIT 1",
    );

    private selectRunById = db.prepare<{ chainId: number; runId: number }>(
        "SELECT run_id, chain_id, collection_id, request_slug, request_opensea_slug, request_address, request_standard, request_extension_key, metadata_mode, enumeration_mode, manual_token_ids_json, manual_range_start_token_id, manual_range_total_supply, request_image_cache_mode, request_image_cache_max_dimension, deployment_block, status, anchor_block, anchor_block_hash, anchor_block_timestamp, error_code, error_message, created_at, updated_at, finished_at " +
            "FROM bootstrap_runs WHERE chain_id = @chainId AND run_id = @runId LIMIT 1",
    );

    private updateRunStatusStmt = db.prepare<{
        runId: number;
        status: BootstrapRunStatus;
        errorCode: string | null;
        errorMessage: string | null;
        finishedAt: string | null;
    }>(
        "UPDATE bootstrap_runs SET " +
            "status = @status, error_code = @errorCode, error_message = @errorMessage, " +
            "finished_at = @finishedAt, updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = @runId",
    );

    private insertRunEventStmt = db.prepare<{
        runId: number;
        chainId: number;
        collectionId: number;
        eventCode: string;
        eventLevel: string;
        message: string;
        payloadJson: string | null;
    }>(
        "INSERT INTO bootstrap_run_events " +
            "(run_id, chain_id, collection_id, event_code, event_level, message, payload_json) " +
            "VALUES (@runId, @chainId, @collectionId, @eventCode, @eventLevel, @message, @payloadJson)",
    );

    private selectRunTaskCounts = db.prepare<{ runId: number }>(
        "SELECT status, COUNT(*) AS count FROM bootstrap_metadata_snapshot_tasks " +
            "WHERE run_id = @runId GROUP BY status",
    );

    private selectRunImageCacheTaskCounts = db.prepare<{ runId: number }>(
        "SELECT status, COUNT(*) AS count FROM bootstrap_image_cache_tasks " +
            "WHERE run_id = @runId GROUP BY status",
    );

    private selectRunOwnershipSnapshotCount = db.prepare<{ runId: number }>(
        "SELECT COUNT(DISTINCT token_id) AS count FROM nft_balance_snapshots " +
            "WHERE run_id = @runId",
    );

    private selectRunSteps = db.prepare<{ runId: number }>(
        "SELECT run_id, step_key, status, blocking, progress_completed, progress_total, last_error, config_json " +
            "FROM bootstrap_run_steps WHERE run_id = @runId ORDER BY rowid ASC",
    );

    private selectRunStep = db.prepare<{
        runId: number;
        stepKey: BootstrapRunStepRecord["stepKey"];
    }>(
        "SELECT run_id, step_key, status, blocking, progress_completed, progress_total, last_error, config_json " +
            "FROM bootstrap_run_steps WHERE run_id = @runId AND step_key = @stepKey LIMIT 1",
    );

    private pauseRunStepStmt = db.prepare<{
        runId: number;
        stepKey: BootstrapRunStepRecord["stepKey"];
        status: BootstrapRunStepRecord["status"];
    }>(
        "UPDATE bootstrap_run_steps SET status = @status, updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = @runId AND step_key = @stepKey",
    );

    private resumeRunStepStmt = db.prepare<{
        runId: number;
        stepKey: BootstrapRunStepRecord["stepKey"];
        status: BootstrapRunStepRecord["status"];
    }>(
        "UPDATE bootstrap_run_steps SET status = @status, next_attempt_at = 0, updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = @runId AND step_key = @stepKey",
    );

    private selectRunEvents = db.prepare<{ runId: number }>(
        "SELECT event_code, event_level, message, created_at, payload_json " +
            "FROM bootstrap_run_events WHERE run_id = @runId ORDER BY id ASC",
    );

    private markFailedTasksRetry = db.prepare<{
        runId: number;
        retryStatus: BootstrapMetadataTaskStatus;
        failedTerminalStatus: BootstrapMetadataTaskStatus;
    }>(
        "UPDATE bootstrap_metadata_snapshot_tasks SET " +
            "status = @retryStatus, next_attempt_at = 0, updated_at = CURRENT_TIMESTAMP " +
            "WHERE run_id = @runId AND status = @failedTerminalStatus",
    );

    findCollectionBySlug(
        chainId: number,
        slug: string,
    ): CollectionBootstrapState | null {
        const row = this.selectCollectionBySlug.get({
            chainId,
            slug: normalizeSlugRef(slug),
        }) as CollectionRow | undefined;
        return row ? mapCollection(row) : null;
    }

    listCollectionsByAddress(
        chainId: number,
        address: string,
    ): CollectionBootstrapState[] {
        const rows = this.selectCollectionsByAddress.all({
            chainId,
            address: normalizeAddressRef(address),
        }) as CollectionRow[];
        return rows.map(mapCollection);
    }

    listCollectionScopeTokenIds(
        chainId: number,
        collectionId: number,
    ): string[] {
        const rows = this.selectCollectionScopeTokens.all({
            chainId,
            collectionId,
        }) as Array<{ token_id: string }>;
        return rows.map((row) => row.token_id);
    }

    resolveCollectionRef(
        chainId: number,
        collectionRef: string,
    ): CollectionBootstrapState | null {
        const trimmed = collectionRef.trim();
        if (!trimmed) return null;
        const row = this.selectCollectionBySlug.get({
            chainId,
            slug: normalizeSlugRef(trimmed),
        }) as CollectionRow | undefined;
        return row ? mapCollection(row) : null;
    }

    getCollectionById(
        chainId: number,
        collectionId: number,
    ): CollectionBootstrapState | null {
        const row = this.selectCollectionById.get({
            chainId,
            collectionId,
        }) as CollectionRow | undefined;
        return row ? mapCollection(row) : null;
    }

    upsertCollectionForBootstrap(input: {
        chainId: number;
        slug: string;
        address: string;
        openseaSlug: string | null;
        standard: "erc721" | "erc1155";
        tokenScopeKind:
            | "contract_all_tokens"
            | "token_range"
            | "explicit_token_ids";
        scopeStartTokenId: string | null;
        scopeTotalSupply: number | null;
        explicitTokenIds: string[];
        deploymentBlock: number | null;
    }): CollectionBootstrapState {
        const run = db.raw.transaction(() => {
            this.upsertCollectionBySlug.run({
                chainId: input.chainId,
                slug: input.slug,
                address: input.address.toLowerCase(),
                openseaSlug: input.openseaSlug,
                standard: input.standard,
                tokenScopeKind: input.tokenScopeKind,
                scopeStartTokenId: input.scopeStartTokenId,
                scopeTotalSupply: input.scopeTotalSupply,
                deploymentBlock: input.deploymentBlock,
            });
            const row = this.selectCollectionBySlug.get({
                chainId: input.chainId,
                slug: input.slug,
            }) as CollectionRow | undefined;
            if (!row) {
                throw new Error("Collection upsert failed");
            }

            this.deleteCollectionScopeTokens.run({
                chainId: input.chainId,
                collectionId: row.collection_id,
            });
            if (input.tokenScopeKind === "explicit_token_ids") {
                for (const tokenId of input.explicitTokenIds) {
                    this.insertCollectionScopeToken.run({
                        chainId: input.chainId,
                        collectionId: row.collection_id,
                        tokenId,
                    });
                }
            }

            return mapCollection(row);
        });
        return run();
    }

    hasActiveRun(chainId: number, collectionId: number): boolean {
        const row = this.selectActiveRunCount.get({
            chainId,
            collectionId,
            requestedStatus: BOOTSTRAP_RUN_STATUS.Requested,
            queuedStatus: BOOTSTRAP_RUN_STATUS.Queued,
            metadataStatus: BOOTSTRAP_RUN_STATUS.Metadata,
            imageCacheStatus: BOOTSTRAP_RUN_STATUS.ImageCache,
            ownershipStatus: BOOTSTRAP_RUN_STATUS.Ownership,
            backfillStatus: BOOTSTRAP_RUN_STATUS.Backfill,
        }) as { count: number } | undefined;
        return (row?.count ?? 0) > 0;
    }

    createRun(input: {
        chainId: number;
        collectionId: number;
        requestSlug: string;
        requestOpenseaSlug: string | null;
        requestAddress: string;
        requestStandard: "erc721" | "erc1155";
        requestExtensionKey: CollectionExtensionKey | null;
        metadataMode: "strict" | "best_effort";
        enumerationMode: "enumerable" | "manual_token_ids" | "manual_range";
        manualTokenIdsJson: string | null;
        manualRangeStartTokenId: string | null;
        manualRangeTotalSupply: number | null;
        imageCacheMode: ImageCacheMode;
        imageCacheMaxDimension: number | null;
        deploymentBlock: number | null;
        steps: readonly BootstrapRunStepPlan[];
    }): BootstrapRunRow {
        const run = db.raw.transaction(() => {
            this.insertRun.run({
                ...input,
                requestedStatus: BOOTSTRAP_RUN_STATUS.Requested,
            });
            const row = this.selectLatestRun.get({
                chainId: input.chainId,
                collectionId: input.collectionId,
            }) as BootstrapRunDbRow | undefined;
            if (!row) {
                throw new Error("Bootstrap run insert failed");
            }
            for (const step of input.steps) {
                this.insertRunStep.run({
                    runId: row.run_id,
                    stepKey: step.stepKey,
                    status: step.status,
                    blocking: step.blocking ? 1 : 0,
                    dependsOnJson: serializeBootstrapStepDependencies(
                        step.dependsOn,
                    ),
                    progressTotal: step.progressTotal,
                    configJson: step.config
                        ? JSON.stringify(step.config)
                        : null,
                });
            }
            return mapRun(row);
        });
        return run();
    }

    updateRunStatus(
        runId: number,
        status: BootstrapRunStatus,
        error?: { code: string; message: string } | null,
    ): void {
        const finishedAt =
            status === BOOTSTRAP_RUN_STATUS.Completed ||
            status === BOOTSTRAP_RUN_STATUS.Failed
                ? new Date().toISOString()
                : null;
        this.updateRunStatusStmt.run({
            runId,
            status,
            errorCode: error?.code ?? null,
            errorMessage: error?.message ?? null,
            finishedAt,
        });
    }

    appendRunEvent(input: {
        runId: number;
        chainId: number;
        collectionId: number;
        eventCode: string;
        eventLevel: "info" | "warn" | "error";
        message: string;
        payloadJson: string | null;
    }): void {
        this.insertRunEventStmt.run(input);
    }

    getLatestRun(
        chainId: number,
        collectionId: number,
    ): BootstrapRunRow | null {
        const row = this.selectLatestRun.get({
            chainId,
            collectionId,
        }) as BootstrapRunDbRow | undefined;
        return row ? mapRun(row) : null;
    }

    getRunById(chainId: number, runId: number): BootstrapRunRow | null {
        const row = this.selectRunById.get({
            chainId,
            runId,
        }) as BootstrapRunDbRow | undefined;
        return row ? mapRun(row) : null;
    }

    listRunEvents(runId: number): BootstrapRunEventRecord[] {
        const rows = this.selectRunEvents.all({
            runId,
        }) as BootstrapRunEventDbRow[];
        return rows.map((row) => ({
            eventCode: row.event_code,
            eventLevel: row.event_level,
            message: row.message,
            createdAt: row.created_at,
            payloadJson: row.payload_json,
        }));
    }

    isLatestRunForCollection(
        chainId: number,
        collectionId: number,
        runId: number,
    ): boolean {
        const latest = this.selectLatestRun.get({
            chainId,
            collectionId,
        }) as BootstrapRunDbRow | undefined;
        return (latest?.run_id ?? 0) === runId;
    }

    listRunsByChain(params: {
        chainId: number;
        status?: string;
        limit: number;
        cursorRunId?: number;
    }): {
        items: BootstrapRunRow[];
        nextCursor: string | null;
    } {
        const where: string[] = ["chain_id = ?"];
        const values: unknown[] = [params.chainId];
        if (params.status) {
            where.push("status = ?");
            values.push(params.status);
        }
        if (params.cursorRunId) {
            where.push("run_id < ?");
            values.push(params.cursorRunId);
        }
        const sql =
            "SELECT run_id, chain_id, collection_id, request_slug, request_opensea_slug, request_address, request_standard, request_extension_key, metadata_mode, enumeration_mode, manual_token_ids_json, manual_range_start_token_id, manual_range_total_supply, request_image_cache_mode, request_image_cache_max_dimension, deployment_block, status, anchor_block, anchor_block_hash, anchor_block_timestamp, error_code, error_message, created_at, updated_at, finished_at " +
            "FROM bootstrap_runs " +
            `WHERE ${where.join(" AND ")} ` +
            "ORDER BY run_id DESC LIMIT ?";
        values.push(params.limit + 1);
        const rows = db.raw.prepare(sql).all(...values) as BootstrapRunDbRow[];
        const hasNext = rows.length > params.limit;
        const pageRows = hasNext ? rows.slice(0, params.limit) : rows;
        return {
            items: pageRows.map(mapRun),
            nextCursor: hasNext
                ? String(pageRows[pageRows.length - 1]!.run_id)
                : null,
        };
    }

    getRunTaskCounts(runId: number): BootstrapRunTaskCounts {
        const rows = this.selectRunTaskCounts.all({
            runId,
        }) as BootstrapTaskCountRow[];
        return mapTaskCountRows(rows);
    }

    getRunImageCacheTaskCounts(runId: number): BootstrapRunTaskCounts {
        const rows = this.selectRunImageCacheTaskCounts.all({
            runId,
        }) as BootstrapTaskCountRow[];
        return mapTaskCountRows(rows);
    }

    getRunOwnershipSnapshotCount(runId: number): number {
        const row = this.selectRunOwnershipSnapshotCount.get({ runId }) as
            | { count: number | bigint }
            | undefined;
        return Number(row?.count ?? 0);
    }

    getRunStep(
        runId: number,
        stepKey: BootstrapRunStepRecord["stepKey"],
    ): BootstrapRunStepRecord | null {
        const row = this.selectRunStep.get({
            runId,
            stepKey,
        }) as BootstrapRunStepDbRow | undefined;
        return row ? mapRunStep(row) : null;
    }

    listRunSteps(runId: number): BootstrapRunStepRecord[] {
        const rows = this.selectRunSteps.all({
            runId,
        }) as BootstrapRunStepDbRow[];
        return rows.map(mapRunStep);
    }

    pauseRunStep(
        runId: number,
        stepKey: BootstrapRunStepRecord["stepKey"],
    ): void {
        this.pauseRunStepStmt.run({
            runId,
            stepKey,
            status: BOOTSTRAP_STEP_STATUS.Paused,
        });
    }

    resumeRunStep(
        runId: number,
        stepKey: BootstrapRunStepRecord["stepKey"],
    ): void {
        this.resumeRunStepStmt.run({
            runId,
            stepKey,
            status: BOOTSTRAP_STEP_STATUS.Ready,
        });
    }

    listRunMetadataTasks(params: {
        runId: number;
        status?: BootstrapMetadataTaskStatus;
        limit: number;
        cursor?: string;
    }): {
        items: BootstrapMetadataTaskListItem[];
        nextCursor: string | null;
    } {
        const where: string[] = ["run_id = ?"];
        const values: unknown[] = [params.runId];
        if (params.status) {
            where.push("status = ?");
            values.push(params.status);
        }
        if (params.cursor) {
            where.push("token_id > ?");
            values.push(params.cursor);
        }
        const sql =
            "SELECT token_id, status, attempts, next_attempt_at, last_error, last_error_at " +
            "FROM bootstrap_metadata_snapshot_tasks " +
            `WHERE ${where.join(" AND ")} ` +
            "ORDER BY token_id ASC LIMIT ?";
        values.push(params.limit + 1);
        const rows = db.raw.prepare(sql).all(...values) as BootstrapTaskDbRow[];
        const hasNext = rows.length > params.limit;
        const pageRows = hasNext ? rows.slice(0, params.limit) : rows;
        return {
            items: pageRows.map((row) => ({
                tokenId: row.token_id,
                status: row.status,
                attempts: row.attempts,
                nextAttemptAt: row.next_attempt_at,
                lastError: row.last_error,
                lastErrorAt: row.last_error_at,
            })),
            nextCursor: hasNext
                ? pageRows[pageRows.length - 1]!.token_id
                : null,
        };
    }

    retryFailedTasks(runId: number): number {
        const result = this.markFailedTasksRetry.run({
            runId,
            retryStatus: BOOTSTRAP_TASK_STATUS.Retry,
            failedTerminalStatus: BOOTSTRAP_TASK_STATUS.FailedTerminal,
        });
        return result.changes;
    }
}

function mapCollection(row: CollectionRow): CollectionBootstrapState {
    return {
        chainId: row.chain_id,
        collectionId: row.collection_id,
        slug: row.slug,
        address: row.address.toLowerCase(),
        standard: row.standard as "erc721" | "erc1155",
        status: row.status as "bootstrapping" | "live" | "paused" | "disabled",
        tokenScopeKind: row.token_scope_kind,
        scopeStartTokenId: row.scope_start_token_id,
        scopeTotalSupply: row.scope_total_supply,
        deploymentBlock: row.deployment_block,
        bootstrapAnchorBlock: row.bootstrap_anchor_block,
        bootstrapStartedAt: row.bootstrap_started_at,
        bootstrapFinishedAt: row.bootstrap_finished_at,
        bootstrapLastSyncedBlock: row.bootstrap_last_synced_block,
        openseaSlug: row.opensea_slug,
        openseaStatus: row.opensea_status,
        openseaReadyAt: row.opensea_ready_at,
        openseaSnapshotStartedAt: row.opensea_snapshot_started_at,
        openseaSnapshotCompletedAt: row.opensea_snapshot_completed_at,
        openseaLastError: row.opensea_last_error,
    };
}

function mapTaskCountRows(
    rows: BootstrapTaskCountRow[],
): BootstrapRunTaskCounts {
    return mapBootstrapTaskStatusCounts(rows as BootstrapTaskStatusCountRow[]);
}

function mapRunStep(row: BootstrapRunStepDbRow): BootstrapRunStepRecord {
    return {
        runId: row.run_id,
        stepKey: row.step_key,
        status: row.status,
        blocking: row.blocking === 1,
        progressCompleted: row.progress_completed,
        progressTotal: row.progress_total,
        lastError: row.last_error,
        configJson: row.config_json,
    };
}

function mapRun(row: BootstrapRunDbRow): BootstrapRunRow {
    return {
        runId: row.run_id,
        chainId: row.chain_id,
        collectionId: row.collection_id,
        requestSlug: row.request_slug,
        requestOpenseaSlug: row.request_opensea_slug,
        requestAddress: row.request_address,
        requestStandard: row.request_standard as "erc721" | "erc1155",
        requestExtensionKey: row.request_extension_key,
        metadataMode: row.metadata_mode,
        enumerationMode: row.enumeration_mode,
        manualTokenIdsJson: row.manual_token_ids_json,
        manualRangeStartTokenId: row.manual_range_start_token_id,
        manualRangeTotalSupply: row.manual_range_total_supply,
        imageCacheMode: normalizeImageCacheMode(row.request_image_cache_mode),
        imageCacheMaxDimension: row.request_image_cache_max_dimension,
        deploymentBlock: row.deployment_block,
        status: row.status,
        anchorBlock: row.anchor_block,
        anchorBlockHash: row.anchor_block_hash,
        anchorBlockTimestamp: row.anchor_block_timestamp,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        finishedAt: row.finished_at,
    };
}

function normalizeImageCacheMode(value: string): ImageCacheMode {
    if (
        value === IMAGE_CACHE_MODE.Off ||
        value === IMAGE_CACHE_MODE.CacheOnce ||
        value === IMAGE_CACHE_MODE.RefreshOnMetadata
    ) {
        return value;
    }
    return IMAGE_CACHE_MODE.Off;
}
