import { db } from "@artgod/shared/database";
import type {
    CollectionStatus,
    OpenSeaStreamIngestionStatus,
} from "@artgod/shared/types";
import { normalizeSlugRef } from "@artgod/shared/utils/ref-resolver";
import type { OpenSeaStreamIngestionState } from "../../application/use-cases/collections/update-opensea-stream-ingestion.js";

type OpenSeaStreamIngestionRow = {
    chain_id: number;
    collection_id: number;
    slug: string;
    status: string;
    opensea_slug: string | null;
    opensea_stream_ingestion_status: string;
};

const OPENSEA_STREAM_INGESTION_SELECT =
    "SELECT chain_id, collection_id, slug, status, opensea_slug, opensea_stream_ingestion_status " +
    "FROM collections ";

export class SqliteOpenSeaStreamIngestionRepository {
    private readonly selectCollectionBySlug = db.prepare<{
        chainId: number;
        slug: string;
    }>(
        OPENSEA_STREAM_INGESTION_SELECT +
            "WHERE chain_id = @chainId AND slug = @slug LIMIT 1",
    );

    private readonly selectCollectionById = db.prepare<{
        chainId: number;
        collectionId: number;
    }>(
        OPENSEA_STREAM_INGESTION_SELECT +
            "WHERE chain_id = @chainId AND collection_id = @collectionId LIMIT 1",
    );

    private readonly updateStatus = db.prepare<{
        chainId: number;
        collectionId: number;
        status: OpenSeaStreamIngestionStatus;
    }>(
        "UPDATE collections SET " +
            "opensea_stream_ingestion_status = @status, " +
            "updated_at = CURRENT_TIMESTAMP " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId",
    );

    resolveCollectionRef(
        chainId: number,
        collectionRef: string,
    ): OpenSeaStreamIngestionState | null {
        const trimmed = collectionRef.trim();
        if (!trimmed) return null;
        const row = this.selectCollectionBySlug.get({
            chainId,
            slug: normalizeSlugRef(trimmed),
        }) as OpenSeaStreamIngestionRow | undefined;
        return row ? mapCollection(row) : null;
    }

    setOpenSeaStreamIngestionStatus(input: {
        chainId: number;
        collectionId: number;
        status: OpenSeaStreamIngestionStatus;
    }): OpenSeaStreamIngestionState | null {
        this.updateStatus.run(input);
        const row = this.selectCollectionById.get({
            chainId: input.chainId,
            collectionId: input.collectionId,
        }) as OpenSeaStreamIngestionRow | undefined;
        return row ? mapCollection(row) : null;
    }
}

function mapCollection(
    row: OpenSeaStreamIngestionRow,
): OpenSeaStreamIngestionState {
    return {
        chainId: row.chain_id,
        collectionId: row.collection_id,
        slug: row.slug,
        status: row.status as CollectionStatus,
        openseaSlug: row.opensea_slug,
        openseaStreamIngestionStatus:
            row.opensea_stream_ingestion_status as OpenSeaStreamIngestionStatus,
    };
}
