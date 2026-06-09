import { db } from "@artgod/shared/database";
import type {
    TokenMetadataRepository,
    TokenMetadataTrait,
} from "../../domain/market/token-metadata-repository.js";

type DatabasePort = Pick<typeof db, "prepare">;

type TokenTraitRow = {
    type: string;
    value: string;
};

// Resolves cached token traits from ArtGod SQLite using collection slug or OpenSea slug.
export class SqliteTokenMetadataRepository implements TokenMetadataRepository {
    private readonly selectTokenTraitRows: {
        all(
            chainId: number,
            collectionSlug: string,
            collectionSlugByOpenSea: string,
            tokenId: string,
        ): TokenTraitRow[];
    };

    constructor(
        private readonly chainId: number,
        database: DatabasePort = db,
    ) {
        this.selectTokenTraitRows = database.prepare<
            [number, string, string, string]
        >(
            "SELECT ak.key AS type, a.value AS value " +
                "FROM collections c " +
                "JOIN token_attributes ta ON ta.chain_id = c.chain_id " +
                "AND ta.collection_id = c.collection_id " +
                "JOIN attributes a ON a.id = ta.attribute_id " +
                "AND a.chain_id = ta.chain_id " +
                "AND a.collection_id = ta.collection_id " +
                "JOIN attribute_keys ak ON ak.id = a.attribute_key_id " +
                "AND ak.chain_id = a.chain_id " +
                "AND ak.collection_id = a.collection_id " +
                "WHERE c.chain_id = ? AND (c.slug = ? OR c.opensea_slug = ?) " +
                "AND ta.token_id = ? " +
                "ORDER BY ak.key ASC, a.value ASC",
        ) as {
            all(
                chainId: number,
                collectionSlug: string,
                collectionSlugByOpenSea: string,
                tokenId: string,
            ): TokenTraitRow[];
        };
    }

    public async getTraits(
        collectionSlug: string,
        tokenId: string,
    ): Promise<TokenMetadataTrait[]> {
        const rows = this.selectTokenTraitRows.all(
            this.chainId,
            collectionSlug,
            collectionSlug,
            tokenId,
        );
        return rows.map((row) => ({ type: row.type, value: row.value }));
    }
}
