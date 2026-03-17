import { db } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import type { MetadataStatsRecomputePayload } from "../../domain/domain-jobs.js";
import type { MetadataStatsDomainPort } from "../../ports/domain-handlers.js";

type StatsCountRow = { count: number };

export class SqliteMetadataStatsDomain implements MetadataStatsDomainPort {
    private deleteCollectionStats = db.prepare<[number, number]>(
        "DELETE FROM collection_trait_stats WHERE chain_id = ? AND collection_id = ?",
    );
    private insertCollectionStats = db.prepare<[number, number]>(
        "INSERT INTO collection_trait_stats " +
            "(chain_id, collection_id, contract_address, attribute_key_id, attribute_id, token_count) " +
            "SELECT ta.chain_id, ta.collection_id, MAX(ta.contract_address), attributes.attribute_key_id, ta.attribute_id, COUNT(DISTINCT ta.token_id) " +
            "FROM token_attributes ta " +
            "JOIN attributes ON attributes.id = ta.attribute_id " +
            "AND attributes.chain_id = ta.chain_id " +
            "AND attributes.collection_id = ta.collection_id " +
            "WHERE ta.chain_id = ? AND ta.collection_id = ? " +
            "GROUP BY ta.chain_id, ta.collection_id, attributes.attribute_key_id, ta.attribute_id",
    );
    private countCollectionStats = db.prepare<[number, number]>(
        "SELECT COUNT(1) as count FROM collection_trait_stats WHERE chain_id = ? AND collection_id = ?",
    );

    async handleRecompute(
        payload: MetadataStatsRecomputePayload,
    ): Promise<void> {
        const run = db.raw.transaction(() => {
            this.deleteCollectionStats.run(
                payload.chainId,
                payload.collectionId,
            );
            this.insertCollectionStats.run(
                payload.chainId,
                payload.collectionId,
            );
        });
        run();

        const row = this.countCollectionStats.get(
            payload.chainId,
            payload.collectionId,
        ) as StatsCountRow | undefined;
        logger.debug("Metadata trait stats recomputed", {
            component: "MetadataStatsDomain",
            action: "handleRecompute",
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            reason: payload.reason,
            rows: row?.count ?? 0,
        });
    }
}
