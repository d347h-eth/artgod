import { db } from "@artgod/shared/database";
import type { TokenMetadataRepository } from "../../domain/market/token-metadata-repository.js";

type DatabasePort = Pick<typeof db, "prepare">;

type MetadataRow = {
    attributes_json: string | null;
};

// Resolves cached token metadata from ArtGod SQLite using collection slug or OpenSea slug.
export class SqliteTokenMetadataRepository implements TokenMetadataRepository {
    private readonly selectAttributesJson: {
        get(
            chainId: number,
            collectionSlug: string,
            collectionSlugByOpenSea: string,
            tokenId: string,
        ): MetadataRow | undefined;
    };

    constructor(
        private readonly chainId: number,
        database: DatabasePort = db,
    ) {
        this.selectAttributesJson = database.prepare<
            [number, string, string, string]
        >(
            "SELECT m.attributes_json " +
                "FROM collections c " +
                "JOIN token_metadata m ON m.chain_id = c.chain_id AND m.collection_id = c.collection_id " +
                "WHERE c.chain_id = ? AND (c.slug = ? OR c.opensea_slug = ?) AND m.token_id = ? " +
                "LIMIT 1",
        ) as {
            get(
                chainId: number,
                collectionSlug: string,
                collectionSlugByOpenSea: string,
                tokenId: string,
            ): MetadataRow | undefined;
        };
    }

    public async getMetadata(
        collectionSlug: string,
        tokenId: string,
    ): Promise<string | null> {
        const row = this.selectAttributesJson.get(
            this.chainId,
            collectionSlug,
            collectionSlug,
            tokenId,
        );
        return row?.attributes_json ?? null;
    }
}
