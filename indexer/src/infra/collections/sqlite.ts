import { db } from "@artgod/shared/database";
import type {
    CollectionRecord,
    CollectionUpsertInput,
    OpenSeaCollectionStatus,
} from "../../domain/collections.js";
import type {
    CollectionRegistryPort,
    CollectionSyncMode,
} from "../../ports/collections.js";

type CollectionRow = {
    chain_id: number;
    collection_id: number;
    address: string;
    standard: string;
    status: string;
    deployment_block: number | null;
    bootstrap_anchor_block: number | null;
    bootstrap_started_at: string | null;
    bootstrap_finished_at: string | null;
    bootstrap_last_synced_block: number | null;
    opensea_slug: string | null;
    opensea_status: string | null;
    opensea_ready_at: string | null;
    opensea_snapshot_started_at: string | null;
    opensea_snapshot_completed_at: string | null;
    opensea_reconcile_started_at: string | null;
    opensea_reconcile_completed_at: string | null;
    opensea_last_stream_event_at: string | null;
    opensea_last_stream_healthy_at: string | null;
    opensea_last_error: string | null;
};

const SELECT_COLLECTIONS_FIELDS =
    "SELECT chain_id, collection_id, address, standard, status, deployment_block, " +
    "bootstrap_anchor_block, bootstrap_started_at, bootstrap_finished_at, bootstrap_last_synced_block, " +
    "opensea_slug, opensea_status, opensea_ready_at, opensea_snapshot_started_at, " +
    "opensea_snapshot_completed_at, opensea_reconcile_started_at, opensea_reconcile_completed_at, " +
    "opensea_last_stream_event_at, opensea_last_stream_healthy_at, opensea_last_error " +
    "FROM collections ";

export class SqliteCollectionRegistry implements CollectionRegistryPort {
    private selectOne = db.prepare<{ chainId: number; collectionId: number }>(
        SELECT_COLLECTIONS_FIELDS +
            "WHERE chain_id = @chainId AND collection_id = @collectionId LIMIT 1",
    );
    private selectLive = db.prepare<{ chainId: number }>(
        SELECT_COLLECTIONS_FIELDS +
            "WHERE chain_id = @chainId AND status = 'live'",
    );
    private selectBackfill = db.prepare<{ chainId: number }>(
        SELECT_COLLECTIONS_FIELDS +
            "WHERE chain_id = @chainId AND status IN ('live', 'bootstrapping')",
    );
    private selectOpenSeaSubscription = db.prepare<{ chainId: number }>(
        SELECT_COLLECTIONS_FIELDS +
            "WHERE chain_id = @chainId " +
            "AND status IN ('live', 'bootstrapping') " +
            "AND opensea_slug IS NOT NULL " +
            "AND opensea_status IS NOT NULL",
    );
    private selectOpenSeaReconcile = db.prepare<{
        chainId: number;
        staleBeforeIso: string;
    }>(
        SELECT_COLLECTIONS_FIELDS +
            "WHERE chain_id = @chainId " +
            "AND status = 'live' " +
            "AND opensea_slug IS NOT NULL " +
            "AND opensea_status IS NOT NULL " +
            "AND (opensea_reconcile_completed_at IS NULL OR opensea_reconcile_completed_at < @staleBeforeIso)",
    );
    private upsert = db.prepare<{
        chainId: number;
        address: string;
        standard: string;
        status: string;
        deploymentBlock: number | null;
        bootstrapAnchorBlock: number | null;
        bootstrapStartedAt: string | null;
        bootstrapFinishedAt: string | null;
        bootstrapLastSyncedBlock: number | null;
    }>(
        "INSERT INTO collections " +
            "(chain_id, address, standard, status, deployment_block, bootstrap_anchor_block, " +
            "bootstrap_started_at, bootstrap_finished_at, bootstrap_last_synced_block) " +
            "VALUES (@chainId, @address, @standard, @status, @deploymentBlock, @bootstrapAnchorBlock, " +
            "@bootstrapStartedAt, @bootstrapFinishedAt, @bootstrapLastSyncedBlock) " +
            "ON CONFLICT(chain_id, address) DO UPDATE SET " +
            "standard = excluded.standard, status = excluded.status, " +
            "deployment_block = excluded.deployment_block, bootstrap_anchor_block = excluded.bootstrap_anchor_block, " +
            "bootstrap_started_at = excluded.bootstrap_started_at, " +
            "bootstrap_finished_at = excluded.bootstrap_finished_at, " +
            "bootstrap_last_synced_block = excluded.bootstrap_last_synced_block, " +
            "updated_at = CURRENT_TIMESTAMP",
    );
    private markStarted = db.prepare<{
        chainId: number;
        collectionId: number;
        anchorBlock: number;
    }>(
        "UPDATE collections SET " +
            "status = 'bootstrapping', " +
            "bootstrap_anchor_block = @anchorBlock, " +
            "bootstrap_started_at = COALESCE(bootstrap_started_at, CURRENT_TIMESTAMP), " +
            "updated_at = CURRENT_TIMESTAMP " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId",
    );
    private markSnapshotProgress = db.prepare<{
        chainId: number;
        collectionId: number;
        lastSyncedBlock: number;
    }>(
        "UPDATE collections SET " +
            "bootstrap_last_synced_block = @lastSyncedBlock, " +
            "updated_at = CURRENT_TIMESTAMP " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId",
    );
    private markFinished = db.prepare<{
        chainId: number;
        collectionId: number;
        lastSyncedBlock: number;
    }>(
        "UPDATE collections SET " +
            "status = 'live', " +
            "bootstrap_last_synced_block = @lastSyncedBlock, " +
            "bootstrap_finished_at = CURRENT_TIMESTAMP, " +
            "updated_at = CURRENT_TIMESTAMP " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId",
    );
    private markOpenSeaPendingStmt = db.prepare<{
        chainId: number;
        collectionId: number;
    }>(
        "UPDATE collections SET " +
            "opensea_status = 'pending', " +
            "opensea_last_error = NULL, " +
            "updated_at = CURRENT_TIMESTAMP " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId",
    );
    private markOpenSeaIdentityRunningStmt = db.prepare<{
        chainId: number;
        collectionId: number;
    }>(
        "UPDATE collections SET " +
            "opensea_status = 'identity_running', " +
            "opensea_last_error = NULL, " +
            "updated_at = CURRENT_TIMESTAMP " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId",
    );
    private setOpenSeaSlugStmt = db.prepare<{
        chainId: number;
        collectionId: number;
        slug: string;
    }>(
        "UPDATE collections SET " +
            "opensea_slug = @slug, " +
            "updated_at = CURRENT_TIMESTAMP " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId",
    );
    private setOpenSeaStatusStmt = db.prepare<{
        chainId: number;
        collectionId: number;
        status: OpenSeaCollectionStatus;
        errorMessage: string | null;
    }>(
        "UPDATE collections SET " +
            "opensea_status = @status, " +
            "opensea_last_error = @errorMessage, " +
            "updated_at = CURRENT_TIMESTAMP " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId",
    );
    private markOpenSeaSnapshotStartedStmt = db.prepare<{
        chainId: number;
        collectionId: number;
    }>(
        "UPDATE collections SET " +
            "opensea_status = 'snapshot_running', " +
            "opensea_snapshot_started_at = CURRENT_TIMESTAMP, " +
            "opensea_last_error = NULL, " +
            "updated_at = CURRENT_TIMESTAMP " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId",
    );
    private markOpenSeaSnapshotCompletedStmt = db.prepare<{
        chainId: number;
        collectionId: number;
    }>(
        "UPDATE collections SET " +
            "opensea_snapshot_completed_at = CURRENT_TIMESTAMP, " +
            "updated_at = CURRENT_TIMESTAMP " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId",
    );
    private markOpenSeaReconcileStartedStmt = db.prepare<{
        chainId: number;
        collectionId: number;
    }>(
        "UPDATE collections SET " +
            "opensea_reconcile_started_at = CURRENT_TIMESTAMP, " +
            "updated_at = CURRENT_TIMESTAMP " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId",
    );
    private markOpenSeaReconcileCompletedStmt = db.prepare<{
        chainId: number;
        collectionId: number;
    }>(
        "UPDATE collections SET " +
            "opensea_reconcile_completed_at = CURRENT_TIMESTAMP, " +
            "updated_at = CURRENT_TIMESTAMP " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId",
    );
    private markOpenSeaReadyStmt = db.prepare<{
        chainId: number;
        collectionId: number;
    }>(
        "UPDATE collections SET " +
            "opensea_status = 'ready', " +
            "opensea_ready_at = COALESCE(opensea_ready_at, CURRENT_TIMESTAMP), " +
            "opensea_last_error = NULL, " +
            "updated_at = CURRENT_TIMESTAMP " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId",
    );
    private touchOpenSeaStreamHealthyStmt = db.prepare<{
        chainId: number;
        collectionId: number;
    }>(
        "UPDATE collections SET " +
            "opensea_last_stream_healthy_at = CURRENT_TIMESTAMP, " +
            "updated_at = CURRENT_TIMESTAMP " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId",
    );
    private touchOpenSeaStreamEventStmt = db.prepare<{
        chainId: number;
        collectionId: number;
    }>(
        "UPDATE collections SET " +
            "opensea_last_stream_event_at = CURRENT_TIMESTAMP, " +
            "opensea_last_stream_healthy_at = CURRENT_TIMESTAMP, " +
            "updated_at = CURRENT_TIMESTAMP " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId",
    );

    getCollection(
        chainId: number,
        collectionId: number,
    ): CollectionRecord | null {
        const row = this.selectOne.get({
            chainId,
            collectionId,
        }) as CollectionRow | undefined;
        return row ? mapRow(row) : null;
    }

    listCollectionsForSync(
        chainId: number,
        mode: CollectionSyncMode,
    ): CollectionRecord[] {
        const rows =
            mode === "realtime"
                ? (this.selectLive.all({ chainId }) as CollectionRow[])
                : (this.selectBackfill.all({ chainId }) as CollectionRow[]);
        return rows.map(mapRow);
    }

    listCollectionsForOpenSeaSubscription(chainId: number): CollectionRecord[] {
        const rows = this.selectOpenSeaSubscription.all({
            chainId,
        }) as CollectionRow[];
        return rows.map(mapRow);
    }

    listCollectionsForOpenSeaReconcile(
        chainId: number,
        staleBeforeIso: string,
    ): CollectionRecord[] {
        const rows = this.selectOpenSeaReconcile.all({
            chainId,
            staleBeforeIso,
        }) as CollectionRow[];
        return rows.map(mapRow);
    }

    upsertCollection(input: CollectionUpsertInput): void {
        this.upsert.run({
            chainId: input.chainId,
            address: input.address,
            standard: input.standard,
            status: input.status,
            deploymentBlock: input.deploymentBlock,
            bootstrapAnchorBlock: input.bootstrapAnchorBlock,
            bootstrapStartedAt: input.bootstrapStartedAt,
            bootstrapFinishedAt: input.bootstrapFinishedAt,
            bootstrapLastSyncedBlock: input.bootstrapLastSyncedBlock,
        });
    }

    markBootstrapStarted(
        chainId: number,
        collectionId: number,
        anchorBlock: number,
    ): boolean {
        const result = this.markStarted.run({
            chainId,
            collectionId,
            anchorBlock,
        });
        return result.changes > 0;
    }

    markBootstrapSnapshotProgress(
        chainId: number,
        collectionId: number,
        lastSyncedBlock: number,
    ): boolean {
        const result = this.markSnapshotProgress.run({
            chainId,
            collectionId,
            lastSyncedBlock,
        });
        return result.changes > 0;
    }

    markBootstrapFinished(
        chainId: number,
        collectionId: number,
        lastSyncedBlock: number,
    ): boolean {
        const result = this.markFinished.run({
            chainId,
            collectionId,
            lastSyncedBlock,
        });
        return result.changes > 0;
    }

    markOpenSeaPending(chainId: number, collectionId: number): boolean {
        return (
            this.markOpenSeaPendingStmt.run({
                chainId,
                collectionId,
            }).changes > 0
        );
    }

    markOpenSeaIdentityRunning(chainId: number, collectionId: number): boolean {
        return (
            this.markOpenSeaIdentityRunningStmt.run({
                chainId,
                collectionId,
            }).changes > 0
        );
    }

    setOpenSeaSlug(
        chainId: number,
        collectionId: number,
        slug: string,
    ): boolean {
        return (
            this.setOpenSeaSlugStmt.run({
                chainId,
                collectionId,
                slug,
            }).changes > 0
        );
    }

    setOpenSeaStatus(
        chainId: number,
        collectionId: number,
        status: OpenSeaCollectionStatus,
        errorMessage?: string | null,
    ): boolean {
        return (
            this.setOpenSeaStatusStmt.run({
                chainId,
                collectionId,
                status,
                errorMessage: errorMessage ?? null,
            }).changes > 0
        );
    }

    markOpenSeaSnapshotStarted(chainId: number, collectionId: number): boolean {
        return (
            this.markOpenSeaSnapshotStartedStmt.run({
                chainId,
                collectionId,
            }).changes > 0
        );
    }

    markOpenSeaSnapshotCompleted(
        chainId: number,
        collectionId: number,
    ): boolean {
        return (
            this.markOpenSeaSnapshotCompletedStmt.run({
                chainId,
                collectionId,
            }).changes > 0
        );
    }

    markOpenSeaReconcileStarted(
        chainId: number,
        collectionId: number,
    ): boolean {
        return (
            this.markOpenSeaReconcileStartedStmt.run({
                chainId,
                collectionId,
            }).changes > 0
        );
    }

    markOpenSeaReconcileCompleted(
        chainId: number,
        collectionId: number,
    ): boolean {
        return (
            this.markOpenSeaReconcileCompletedStmt.run({
                chainId,
                collectionId,
            }).changes > 0
        );
    }

    markOpenSeaReady(chainId: number, collectionId: number): boolean {
        return (
            this.markOpenSeaReadyStmt.run({
                chainId,
                collectionId,
            }).changes > 0
        );
    }

    touchOpenSeaStreamHealthy(chainId: number, collectionId: number): boolean {
        return (
            this.touchOpenSeaStreamHealthyStmt.run({
                chainId,
                collectionId,
            }).changes > 0
        );
    }

    touchOpenSeaStreamEvent(chainId: number, collectionId: number): boolean {
        return (
            this.touchOpenSeaStreamEventStmt.run({
                chainId,
                collectionId,
            }).changes > 0
        );
    }
}

function mapRow(row: CollectionRow): CollectionRecord {
    return {
        chainId: row.chain_id,
        id: row.collection_id,
        address: row.address,
        standard: row.standard as CollectionRecord["standard"],
        status: row.status as CollectionRecord["status"],
        deploymentBlock: row.deployment_block,
        bootstrapAnchorBlock: row.bootstrap_anchor_block,
        bootstrapStartedAt: row.bootstrap_started_at,
        bootstrapFinishedAt: row.bootstrap_finished_at,
        bootstrapLastSyncedBlock: row.bootstrap_last_synced_block,
        openseaSlug: row.opensea_slug,
        openseaStatus: row.opensea_status as CollectionRecord["openseaStatus"],
        openseaReadyAt: row.opensea_ready_at,
        openseaSnapshotStartedAt: row.opensea_snapshot_started_at,
        openseaSnapshotCompletedAt: row.opensea_snapshot_completed_at,
        openseaReconcileStartedAt: row.opensea_reconcile_started_at,
        openseaReconcileCompletedAt: row.opensea_reconcile_completed_at,
        openseaLastStreamEventAt: row.opensea_last_stream_event_at,
        openseaLastStreamHealthyAt: row.opensea_last_stream_healthy_at,
        openseaLastError: row.opensea_last_error,
    };
}
