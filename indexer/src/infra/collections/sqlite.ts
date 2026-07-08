import { db } from "@artgod/shared/database";
import {
    COLLECTION_STATUS,
    OPENSEA_COLLECTION_STATUS,
    OPENSEA_STREAM_INGESTION_STATUS,
    type CollectionStatus,
    type OpenSeaCollectionStatus,
    type OpenSeaStreamIngestionStatus,
} from "@artgod/shared/types";
import {
    CollectionRecord,
    CollectionUpsertInput,
} from "../../domain/collections.js";
import type {
    CollectionScopeRange,
    CollectionScopeResolverPort,
    CollectionRegistryPort,
    CollectionSyncMode,
} from "../../ports/collections.js";

type CollectionRow = {
    chain_id: number;
    collection_id: number;
    slug: string;
    address: string;
    standard: string;
    status: string;
    token_scope_kind: string;
    scope_start_token_id: string | null;
    scope_total_supply: number | null;
    deployment_block: number | null;
    bootstrap_anchor_block: number | null;
    bootstrap_started_at: string | null;
    bootstrap_finished_at: string | null;
    bootstrap_last_synced_block: number | null;
    opensea_slug: string | null;
    opensea_status: string | null;
    opensea_stream_ingestion_status: string;
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
    "SELECT chain_id, collection_id, slug, address, standard, status, token_scope_kind, scope_start_token_id, scope_total_supply, deployment_block, " +
    "bootstrap_anchor_block, bootstrap_started_at, bootstrap_finished_at, bootstrap_last_synced_block, " +
    "opensea_slug, opensea_status, opensea_stream_ingestion_status, opensea_ready_at, opensea_snapshot_started_at, " +
    "opensea_snapshot_completed_at, opensea_reconcile_started_at, opensea_reconcile_completed_at, " +
    "opensea_last_stream_event_at, opensea_last_stream_healthy_at, opensea_last_error " +
    "FROM collections ";

export class SqliteCollectionRegistry
    implements CollectionRegistryPort, CollectionScopeResolverPort
{
    private selectOne = db.prepare<{ chainId: number; collectionId: number }>(
        SELECT_COLLECTIONS_FIELDS +
            "WHERE chain_id = @chainId AND collection_id = @collectionId LIMIT 1",
    );
    private selectRealtime = db.prepare<{
        chainId: number;
        liveStatus: CollectionStatus;
        bootstrappingStatus: CollectionStatus;
    }>(
        SELECT_COLLECTIONS_FIELDS +
            "WHERE chain_id = @chainId " +
            "AND (status = @liveStatus OR (status = @bootstrappingStatus AND bootstrap_anchor_block IS NOT NULL))",
    );
    private selectBackfill = db.prepare<{
        chainId: number;
        liveStatus: CollectionStatus;
        bootstrappingStatus: CollectionStatus;
    }>(
        SELECT_COLLECTIONS_FIELDS +
            "WHERE chain_id = @chainId AND status IN (@liveStatus, @bootstrappingStatus)",
    );
    private selectOpenSeaSubscription = db.prepare<{
        chainId: number;
        liveStatus: CollectionStatus;
        bootstrappingStatus: CollectionStatus;
        streamIngestionStatus: OpenSeaStreamIngestionStatus;
    }>(
        SELECT_COLLECTIONS_FIELDS +
            "WHERE chain_id = @chainId " +
            "AND status IN (@liveStatus, @bootstrappingStatus) " +
            "AND opensea_slug IS NOT NULL " +
            "AND opensea_status IS NOT NULL " +
            "AND opensea_stream_ingestion_status = @streamIngestionStatus",
    );
    private selectOpenSeaReconcile = db.prepare<{
        chainId: number;
        staleBeforeIso: string;
        liveStatus: CollectionStatus;
    }>(
        SELECT_COLLECTIONS_FIELDS +
            "WHERE chain_id = @chainId " +
            "AND status = @liveStatus " +
            "AND opensea_slug IS NOT NULL " +
            "AND opensea_status IS NOT NULL " +
            "AND (opensea_reconcile_completed_at IS NULL OR opensea_reconcile_completed_at < @staleBeforeIso)",
    );
    private upsert = db.prepare<{
        chainId: number;
        slug: string;
        address: string;
        standard: string;
        status: string;
        tokenScopeKind: string;
        scopeStartTokenId: string | null;
        scopeTotalSupply: number | null;
        deploymentBlock: number | null;
        bootstrapAnchorBlock: number | null;
        bootstrapStartedAt: string | null;
        bootstrapFinishedAt: string | null;
        bootstrapLastSyncedBlock: number | null;
    }>(
        "INSERT INTO collections " +
            "(chain_id, slug, address, standard, status, token_scope_kind, scope_start_token_id, scope_total_supply, deployment_block, bootstrap_anchor_block, " +
            "bootstrap_started_at, bootstrap_finished_at, bootstrap_last_synced_block) " +
            "VALUES (@chainId, @slug, @address, @standard, @status, @tokenScopeKind, @scopeStartTokenId, @scopeTotalSupply, @deploymentBlock, @bootstrapAnchorBlock, " +
            "@bootstrapStartedAt, @bootstrapFinishedAt, @bootstrapLastSyncedBlock) " +
            "ON CONFLICT(chain_id, slug) DO UPDATE SET " +
            "address = excluded.address, standard = excluded.standard, status = excluded.status, " +
            "token_scope_kind = excluded.token_scope_kind, " +
            "scope_start_token_id = excluded.scope_start_token_id, " +
            "scope_total_supply = excluded.scope_total_supply, " +
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
        status: CollectionStatus;
    }>(
        "UPDATE collections SET " +
            "status = @status, " +
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
        status: CollectionStatus;
    }>(
        "UPDATE collections SET " +
            "status = @status, " +
            "bootstrap_last_synced_block = @lastSyncedBlock, " +
            "bootstrap_finished_at = CURRENT_TIMESTAMP, " +
            "updated_at = CURRENT_TIMESTAMP " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId",
    );
    private markOpenSeaPendingStmt = db.prepare<{
        chainId: number;
        collectionId: number;
        status: OpenSeaCollectionStatus;
    }>(
        "UPDATE collections SET " +
            "opensea_status = @status, " +
            "opensea_last_error = NULL, " +
            "updated_at = CURRENT_TIMESTAMP " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId",
    );
    private markOpenSeaIdentityRunningStmt = db.prepare<{
        chainId: number;
        collectionId: number;
        status: OpenSeaCollectionStatus;
    }>(
        "UPDATE collections SET " +
            "opensea_status = @status, " +
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
        status: OpenSeaCollectionStatus;
    }>(
        "UPDATE collections SET " +
            "opensea_status = @status, " +
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
        status: OpenSeaCollectionStatus;
    }>(
        "UPDATE collections SET " +
            "opensea_status = @status, " +
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
    private selectExplicitScopeToken = db.prepare<{
        chainId: number;
        collectionId: number;
        tokenId: string;
    }>(
        "SELECT 1 FROM collection_scope_tokens " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId AND token_id = @tokenId " +
            "LIMIT 1",
    );
    private selectExplicitScopeTokenIds = db.prepare<{
        chainId: number;
        collectionId: number;
    }>(
        "SELECT token_id FROM collection_scope_tokens " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId " +
            "ORDER BY token_id",
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
                ? (this.selectRealtime.all(
                      syncStatusQuery(chainId),
                  ) as CollectionRow[])
                : (this.selectBackfill.all(
                      syncStatusQuery(chainId),
                  ) as CollectionRow[]);
        return rows.map(mapRow);
    }

    listCollectionsForOpenSeaSubscription(chainId: number): CollectionRecord[] {
        const rows = this.selectOpenSeaSubscription.all(
            openSeaSubscriptionQuery(chainId),
        ) as CollectionRow[];
        return rows.map(mapRow);
    }

    listCollectionsForOpenSeaReconcile(
        chainId: number,
        staleBeforeIso: string,
    ): CollectionRecord[] {
        const rows = this.selectOpenSeaReconcile.all({
            chainId,
            staleBeforeIso,
            liveStatus: COLLECTION_STATUS.Live,
        }) as CollectionRow[];
        return rows.map(mapRow);
    }

    upsertCollection(input: CollectionUpsertInput): void {
        const persisted = input.toPersistence();
        this.upsert.run({
            chainId: persisted.chainId,
            slug: persisted.slug,
            address: persisted.address.toLowerCase(),
            standard: persisted.standard,
            status: persisted.status,
            tokenScopeKind: persisted.tokenScopeKind,
            scopeStartTokenId: persisted.scopeStartTokenId,
            scopeTotalSupply: persisted.scopeTotalSupply,
            deploymentBlock: persisted.deploymentBlock,
            bootstrapAnchorBlock: persisted.bootstrapAnchorBlock,
            bootstrapStartedAt: persisted.bootstrapStartedAt,
            bootstrapFinishedAt: persisted.bootstrapFinishedAt,
            bootstrapLastSyncedBlock: persisted.bootstrapLastSyncedBlock,
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
            status: COLLECTION_STATUS.Bootstrapping,
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
            status: COLLECTION_STATUS.Live,
        });
        return result.changes > 0;
    }

    markOpenSeaPending(chainId: number, collectionId: number): boolean {
        return (
            this.markOpenSeaPendingStmt.run({
                chainId,
                collectionId,
                status: OPENSEA_COLLECTION_STATUS.Pending,
            }).changes > 0
        );
    }

    markOpenSeaIdentityRunning(chainId: number, collectionId: number): boolean {
        return (
            this.markOpenSeaIdentityRunningStmt.run({
                chainId,
                collectionId,
                status: OPENSEA_COLLECTION_STATUS.IdentityRunning,
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
                status: OPENSEA_COLLECTION_STATUS.SnapshotRunning,
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
                status: OPENSEA_COLLECTION_STATUS.Ready,
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

    hasExplicitScopeToken(
        chainId: number,
        collectionId: number,
        tokenId: string,
    ): boolean {
        return Boolean(
            this.selectExplicitScopeToken.get({
                chainId,
                collectionId,
                tokenId,
            }),
        );
    }

    listExplicitScopeTokenIds(chainId: number, collectionId: number): string[] {
        const rows = this.selectExplicitScopeTokenIds.all({
            chainId,
            collectionId,
        }) as Array<{ token_id: string }>;
        return rows.map((row) => row.token_id);
    }

    resolveTokenScopedCollectionId(
        chainId: number,
        collections: CollectionRecord[],
        contract: string,
        tokenId: string,
    ): number | null {
        const matchingCollections = collections.filter(
            (collection) =>
                collection.address.toLowerCase() === contract.toLowerCase(),
        );
        if (matchingCollections.length === 0) {
            return null;
        }

        const matches = matchingCollections.filter((collection) =>
            collection.containsTokenInScope(tokenId, (candidateTokenId) =>
                this.hasExplicitScopeToken(
                    chainId,
                    collection.id,
                    candidateTokenId,
                ),
            ),
        );
        if (matches.length !== 1) {
            return null;
        }

        return matches[0]!.id;
    }

    resolveContractScopedCollectionIds(
        _chainId: number,
        collections: CollectionRecord[],
        contract: string,
    ): number[] {
        // Contract-wide events, such as ApprovalForAll, affect every local scope on that NFT contract.
        return collections
            .filter(
                (collection) =>
                    collection.address.toLowerCase() ===
                    contract.toLowerCase(),
            )
            .map((collection) => collection.id);
    }

    splitRangeByCollectionScope(
        chainId: number,
        collections: CollectionRecord[],
        contract: string,
        fromTokenId: string,
        toTokenId: string,
    ): CollectionScopeRange[] {
        const matchingCollections = collections.filter(
            (collection) =>
                collection.address.toLowerCase() === contract.toLowerCase(),
        );
        if (matchingCollections.length === 0) {
            return [];
        }

        const rangeStart = BigInt(fromTokenId);
        const rangeEnd = BigInt(toTokenId);
        const ranges: CollectionScopeRange[] = [];

        for (const collection of matchingCollections) {
            const continuousRange = collection.intersectContinuousTokenRange(
                fromTokenId,
                toTokenId,
            );
            if (continuousRange) {
                ranges.push({
                    collectionId: collection.id,
                    fromTokenId: continuousRange.fromTokenId,
                    toTokenId: continuousRange.toTokenId,
                });
                continue;
            }

            if (!collection.isExplicitTokenIdsScope()) {
                continue;
            }

            const tokenIds = this.listExplicitScopeTokenIds(
                chainId,
                collection.id,
            ).filter((tokenId) => {
                const value = BigInt(tokenId);
                return value >= rangeStart && value <= rangeEnd;
            });

            for (const tokenId of tokenIds) {
                ranges.push({
                    collectionId: collection.id,
                    fromTokenId: tokenId,
                    toTokenId: tokenId,
                });
            }
        }

        return ranges;
    }
}

function mapRow(row: CollectionRow): CollectionRecord {
    return CollectionRecord.fromPersistence({
        chainId: row.chain_id,
        id: row.collection_id,
        slug: row.slug,
        address: row.address,
        standard: row.standard as "erc721" | "erc1155",
        status: row.status as CollectionStatus,
        tokenScopeKind: row.token_scope_kind,
        scopeStartTokenId: row.scope_start_token_id,
        scopeTotalSupply: row.scope_total_supply,
        deploymentBlock: row.deployment_block,
        bootstrapAnchorBlock: row.bootstrap_anchor_block,
        bootstrapStartedAt: row.bootstrap_started_at,
        bootstrapFinishedAt: row.bootstrap_finished_at,
        bootstrapLastSyncedBlock: row.bootstrap_last_synced_block,
        openseaSlug: row.opensea_slug,
        openseaStatus: row.opensea_status as CollectionRecord["openseaStatus"],
        openseaStreamIngestionStatus:
            row.opensea_stream_ingestion_status as OpenSeaStreamIngestionStatus,
        openseaReadyAt: row.opensea_ready_at,
        openseaSnapshotStartedAt: row.opensea_snapshot_started_at,
        openseaSnapshotCompletedAt: row.opensea_snapshot_completed_at,
        openseaReconcileStartedAt: row.opensea_reconcile_started_at,
        openseaReconcileCompletedAt: row.opensea_reconcile_completed_at,
        openseaLastStreamEventAt: row.opensea_last_stream_event_at,
        openseaLastStreamHealthyAt: row.opensea_last_stream_healthy_at,
        openseaLastError: row.opensea_last_error,
    });
}

function syncStatusQuery(chainId: number): {
    chainId: number;
    liveStatus: CollectionStatus;
    bootstrappingStatus: CollectionStatus;
} {
    return {
        chainId,
        liveStatus: COLLECTION_STATUS.Live,
        bootstrappingStatus: COLLECTION_STATUS.Bootstrapping,
    };
}

function openSeaSubscriptionQuery(chainId: number): {
    chainId: number;
    liveStatus: CollectionStatus;
    bootstrappingStatus: CollectionStatus;
    streamIngestionStatus: OpenSeaStreamIngestionStatus;
} {
    return {
        ...syncStatusQuery(chainId),
        streamIngestionStatus: OPENSEA_STREAM_INGESTION_STATUS.Enabled,
    };
}
