import { db } from "@artgod/shared/database";
import { OPENSEA_COLLECTION_STATUS } from "@artgod/shared/types";
import type {
    CollectionStatus,
    OpenSeaCollectionStatus,
} from "@artgod/shared/types";
import { normalizeSlugRef } from "@artgod/shared/utils/ref-resolver";
import type { OpenSeaCollectionSyncState } from "../../application/use-cases/collections/start-opensea-collection-sync.js";

type OpenSeaCollectionSyncRow = {
    chain_id: number;
    collection_id: number;
    slug: string;
    address: string;
    status: string;
    opensea_slug: string | null;
    opensea_status: string | null;
    opensea_last_error: string | null;
};

export class SqliteOpenSeaCollectionSyncRepository {
    private readonly selectCollectionBySlug = db.prepare<{
        chainId: number;
        slug: string;
    }>(
        "SELECT chain_id, collection_id, slug, address, status, opensea_slug, " +
            "opensea_status, opensea_last_error " +
            "FROM collections " +
            "WHERE chain_id = @chainId AND slug = @slug LIMIT 1",
    );

    private readonly selectCollectionById = db.prepare<{
        chainId: number;
        collectionId: number;
    }>(
        "SELECT chain_id, collection_id, slug, address, status, opensea_slug, " +
            "opensea_status, opensea_last_error " +
            "FROM collections " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId LIMIT 1",
    );

    private readonly selectOpenSeaSlugOwner = db.prepare<{
        chainId: number;
        openseaSlug: string;
    }>(
        "SELECT collection_id " +
            "FROM collections " +
            "WHERE chain_id = @chainId AND opensea_slug = @openseaSlug LIMIT 1",
    );

    private readonly markOpenSeaPendingStmt = db.prepare<{
        chainId: number;
        collectionId: number;
        openseaSlug: string;
        status: OpenSeaCollectionStatus;
    }>(
        "UPDATE collections SET " +
            "opensea_slug = @openseaSlug, " +
            "opensea_status = @status, " +
            "opensea_last_error = NULL, " +
            "updated_at = CURRENT_TIMESTAMP " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId",
    );

    private readonly restoreOpenSeaStateStmt = db.prepare<{
        chainId: number;
        collectionId: number;
        openseaSlug: string | null;
        status: OpenSeaCollectionStatus | null;
        lastError: string | null;
    }>(
        "UPDATE collections SET " +
            "opensea_slug = @openseaSlug, " +
            "opensea_status = @status, " +
            "opensea_last_error = @lastError, " +
            "updated_at = CURRENT_TIMESTAMP " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId",
    );

    resolveCollectionRef(
        chainId: number,
        collectionRef: string,
    ): OpenSeaCollectionSyncState | null {
        const trimmed = collectionRef.trim();
        if (!trimmed) return null;
        const row = this.selectCollectionBySlug.get({
            chainId,
            slug: normalizeSlugRef(trimmed),
        }) as OpenSeaCollectionSyncRow | undefined;
        return row ? mapCollection(row) : null;
    }

    resolveOpenSeaSlugOwner(
        chainId: number,
        openseaSlug: string,
    ): { collectionId: number } | null {
        const row = this.selectOpenSeaSlugOwner.get({
            chainId,
            openseaSlug,
        }) as { collection_id: number } | undefined;
        return row ? { collectionId: row.collection_id } : null;
    }

    markOpenSeaPending(input: {
        chainId: number;
        collectionId: number;
        openseaSlug: string;
    }): OpenSeaCollectionSyncState | null {
        this.markOpenSeaPendingStmt.run({
            chainId: input.chainId,
            collectionId: input.collectionId,
            openseaSlug: input.openseaSlug,
            status: OPENSEA_COLLECTION_STATUS.Pending,
        });
        const row = this.selectCollectionById.get({
            chainId: input.chainId,
            collectionId: input.collectionId,
        }) as OpenSeaCollectionSyncRow | undefined;
        return row ? mapCollection(row) : null;
    }

    restoreOpenSeaState(input: {
        chainId: number;
        collectionId: number;
        openseaSlug: string | null;
        openseaStatus: OpenSeaCollectionStatus | null;
        openseaLastError: string | null;
    }): OpenSeaCollectionSyncState | null {
        this.restoreOpenSeaStateStmt.run({
            chainId: input.chainId,
            collectionId: input.collectionId,
            openseaSlug: input.openseaSlug,
            status: input.openseaStatus,
            lastError: input.openseaLastError,
        });
        const row = this.selectCollectionById.get({
            chainId: input.chainId,
            collectionId: input.collectionId,
        }) as OpenSeaCollectionSyncRow | undefined;
        return row ? mapCollection(row) : null;
    }
}

function mapCollection(
    row: OpenSeaCollectionSyncRow,
): OpenSeaCollectionSyncState {
    return {
        chainId: row.chain_id,
        collectionId: row.collection_id,
        slug: row.slug,
        address: row.address,
        status: row.status as CollectionStatus,
        openseaSlug: row.opensea_slug,
        openseaStatus: row.opensea_status as OpenSeaCollectionStatus | null,
        openseaLastError: row.opensea_last_error,
    };
}
