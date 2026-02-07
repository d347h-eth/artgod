import { db } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import type { MetadataStatsRecomputePayload } from "../../domain/domain-jobs.js";
import type { MetadataStatsDomainPort } from "../../ports/domain-handlers.js";

type StatsCountRow = { count: number };

export class SqliteMetadataStatsDomain implements MetadataStatsDomainPort {
    private deleteCollectionStats = db.prepare<[number, string]>(
        "DELETE FROM collection_trait_stats WHERE chain_id = ? AND contract_address = ?",
    );
    private insertCollectionStats = db.prepare<[number, string]>(
        "INSERT INTO collection_trait_stats " +
            "(chain_id, contract_address, attribute_key_id, attribute_id, token_count) " +
            "SELECT ta.chain_id, ta.contract_address, attributes.attribute_key_id, ta.attribute_id, COUNT(DISTINCT ta.token_id) " +
            "FROM token_attributes ta " +
            "JOIN attributes ON attributes.id = ta.attribute_id " +
            "AND attributes.chain_id = ta.chain_id " +
            "AND attributes.contract_address = ta.contract_address " +
            "WHERE ta.chain_id = ? AND ta.contract_address = ? " +
            "GROUP BY ta.chain_id, ta.contract_address, attributes.attribute_key_id, ta.attribute_id",
    );
    private countCollectionStats = db.prepare<[number, string]>(
        "SELECT COUNT(1) as count FROM collection_trait_stats WHERE chain_id = ? AND contract_address = ?",
    );

    async handleRecompute(
        payload: MetadataStatsRecomputePayload,
    ): Promise<void> {
        const contract = payload.contract.toLowerCase();
        const run = db.raw.transaction(() => {
            this.deleteCollectionStats.run(payload.chainId, contract);
            this.insertCollectionStats.run(payload.chainId, contract);
        });
        run();

        const row = this.countCollectionStats.get(payload.chainId, contract) as
            | StatsCountRow
            | undefined;
        logger.debug("Metadata trait stats recomputed", {
            component: "MetadataStatsDomain",
            action: "handleRecompute",
            chainId: payload.chainId,
            contract,
            reason: payload.reason,
            rows: row?.count ?? 0,
        });
    }
}
