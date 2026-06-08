import { db } from "@artgod/shared/database";
import type { TokenImageCacheResult } from "../../ports/token-image-cache.js";

export type TokenImageSourceRecord = {
    tokenId: string;
    sourceImageUrl: string;
};

export class SqliteTokenImageCacheRecords {
    private readonly selectTokenImageSourceStmt = db.prepare<{
        chainId: number;
        collectionId: number;
        tokenId: string;
    }>(
        "SELECT token_id, image AS source_image_url FROM token_metadata " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId " +
            "AND token_id = @tokenId AND image IS NOT NULL AND trim(image) <> '' " +
            "LIMIT 1",
    );

    private readonly selectCollectionImageSourcesStmt = db.prepare<{
        chainId: number;
        collectionId: number;
        cursorTokenId: string;
        limit: number;
    }>(
        "SELECT token_id, image AS source_image_url FROM token_metadata " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId " +
            "AND token_id > @cursorTokenId " +
            "AND image IS NOT NULL AND trim(image) <> '' " +
            "ORDER BY token_id ASC LIMIT @limit",
    );

    private readonly upsertTokenImageCacheStmt = db.prepare<
        TokenImageSourceRecord &
            TokenImageCacheResult & {
                chainId: number;
                collectionId: number;
                requestedMaxDimension: number | null;
            }
    >(
        "INSERT INTO token_image_cache " +
            "(chain_id, collection_id, token_id, source_image_url, requested_max_dimension, cache_key, content_type, source_bytes, cached_bytes, width, height, relative_path, public_path) " +
            "VALUES (@chainId, @collectionId, @tokenId, @sourceImageUrl, @requestedMaxDimension, @cacheKey, @contentType, @sourceBytes, @cachedBytes, @width, @height, @relativePath, @publicPath) " +
            "ON CONFLICT(chain_id, collection_id, token_id) DO UPDATE SET " +
            "source_image_url = excluded.source_image_url, requested_max_dimension = excluded.requested_max_dimension, " +
            "cache_key = excluded.cache_key, content_type = excluded.content_type, source_bytes = excluded.source_bytes, " +
            "cached_bytes = excluded.cached_bytes, width = excluded.width, height = excluded.height, " +
            "relative_path = excluded.relative_path, public_path = excluded.public_path, updated_at = CURRENT_TIMESTAMP",
    );

    getTokenImageSource(input: {
        chainId: number;
        collectionId: number;
        tokenId: string;
    }): TokenImageSourceRecord | null {
        const row = this.selectTokenImageSourceStmt.get(
            input,
        ) as TokenImageSourceDbRow | undefined;
        return row ? mapTokenImageSource(row) : null;
    }

    listCollectionImageSources(input: {
        chainId: number;
        collectionId: number;
        cursorTokenId: string | null;
        limit: number;
    }): TokenImageSourceRecord[] {
        const rows = this.selectCollectionImageSourcesStmt.all({
            chainId: input.chainId,
            collectionId: input.collectionId,
            cursorTokenId: input.cursorTokenId ?? "",
            limit: input.limit,
        }) as TokenImageSourceDbRow[];
        return rows.map(mapTokenImageSource);
    }

    upsertTokenImageCache(
        input: TokenImageSourceRecord &
            TokenImageCacheResult & {
                chainId: number;
                collectionId: number;
                requestedMaxDimension: number | null;
            },
    ): void {
        this.upsertTokenImageCacheStmt.run(input);
    }
}

type TokenImageSourceDbRow = {
    token_id: string;
    source_image_url: string;
};

function mapTokenImageSource(row: TokenImageSourceDbRow): TokenImageSourceRecord {
    return {
        tokenId: row.token_id,
        sourceImageUrl: row.source_image_url,
    };
}
