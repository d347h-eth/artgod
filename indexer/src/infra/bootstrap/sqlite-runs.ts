import { db } from "@artgod/shared/database";
import type { CollectionExtensionKey } from "@artgod/shared/extensions";
import {
    IMAGE_CACHE_MODE,
    type ImageCacheMode,
} from "@artgod/shared/media/token-image-cache";
import type {
    BootstrapRunDefinition,
    BootstrapRunsPort,
} from "../../ports/bootstrap-runs.js";

type BootstrapRunDbRow = {
    run_id: number;
    chain_id: number;
    collection_id: number;
    request_slug: string;
    request_address: string;
    request_standard: "erc721" | "erc1155";
    request_extension_key: CollectionExtensionKey | null;
    metadata_mode: "strict" | "best_effort";
    enumeration_mode: "enumerable" | "manual_token_ids" | "manual_range";
    manual_token_ids_json: string | null;
    manual_range_start_token_id: string | null;
    manual_range_total_supply: number | null;
    request_image_cache_mode: string;
    request_image_cache_max_dimension: number | null;
    deployment_block: number | null;
    status: string;
    anchor_block: number | null;
    anchor_block_hash: string | null;
    anchor_block_timestamp: number | null;
};

export class SqliteBootstrapRuns implements BootstrapRunsPort {
    private selectRunStmt = db.prepare<{ runId: number }>(
        "SELECT run_id, chain_id, collection_id, request_slug, request_address, request_standard, request_extension_key, metadata_mode, enumeration_mode, manual_token_ids_json, manual_range_start_token_id, manual_range_total_supply, request_image_cache_mode, request_image_cache_max_dimension, deployment_block, status, anchor_block, anchor_block_hash, anchor_block_timestamp " +
            "FROM bootstrap_runs WHERE run_id = @runId LIMIT 1",
    );

    private updateRunStatusStmt = db.prepare<{
        runId: number;
        status: string;
        errorCode: string | null;
        errorMessage: string | null;
        finishedAt: string | null;
    }>(
        "UPDATE bootstrap_runs SET status = @status, error_code = @errorCode, error_message = @errorMessage, finished_at = @finishedAt, updated_at = CURRENT_TIMESTAMP WHERE run_id = @runId",
    );

    private updateRunAnchorStmt = db.prepare<{
        runId: number;
        anchorBlock: number;
        anchorHash: string;
        anchorTimestamp: number;
    }>(
        "UPDATE bootstrap_runs SET anchor_block = @anchorBlock, anchor_block_hash = @anchorHash, anchor_block_timestamp = @anchorTimestamp, updated_at = CURRENT_TIMESTAMP WHERE run_id = @runId",
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

    getRun(runId: number): BootstrapRunDefinition | null {
        const row = this.selectRunStmt.get({
            runId,
        }) as BootstrapRunDbRow | undefined;
        return row ? mapRun(row) : null;
    }

    updateRunStatus(
        runId: number,
        status: string,
        error?: { code: string; message: string } | null,
    ): void {
        const finishedAt =
            status === "completed" || status === "failed"
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

    updateRunAnchor(input: {
        runId: number;
        anchorBlock: number;
        anchorHash: string;
        anchorTimestamp: number;
    }): void {
        this.updateRunAnchorStmt.run({
            runId: input.runId,
            anchorBlock: input.anchorBlock,
            anchorHash: input.anchorHash,
            anchorTimestamp: input.anchorTimestamp,
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
}

function mapRun(row: BootstrapRunDbRow): BootstrapRunDefinition {
    return {
        runId: row.run_id,
        chainId: row.chain_id,
        collectionId: row.collection_id,
        requestSlug: row.request_slug,
        requestAddress: row.request_address,
        requestStandard: row.request_standard,
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
