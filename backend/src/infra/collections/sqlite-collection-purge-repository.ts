import { db, type BetterSqlite3NamedStatement } from "@artgod/shared/database";
import type { PurgeCollectionDeletedRowCount } from "../../application/use-cases/collections/purge-collection.js";

type PurgeCollectionParams = {
    chainId: number;
    collectionId: number;
};

type DeleteStatement = {
    table: string;
    statement: BetterSqlite3NamedStatement<PurgeCollectionParams>;
};

type TableNameRow = {
    name: string;
};

type TableColumnInfoRow = {
    name: string;
};

type CountRow = {
    count: number;
};

// Collection-scoped tables added after the original purge path need explicit deletes.
export const COLLECTION_PURGE_LATE_SCHEMA_TABLE = {
    SyntheticTokenRetirements: "collection_extension_synthetic_token_retirements",
    BiddingOrderCancellations: "trading_bidding_order_cancellations",
} as const;

// SqliteCollectionPurgeRepository owns the destructive collection-scoped delete transaction.
export class SqliteCollectionPurgeRepository {
    private readonly deleteStatements: DeleteStatement[];

    constructor() {
        this.deleteStatements = [
            this.deleteFrom(
                "activity_sources",
                "DELETE FROM activity_sources " +
                    "WHERE activity_id IN (" +
                    "SELECT id FROM activities WHERE chain_id = @chainId AND collection_id = @collectionId" +
                    ")",
            ),
            this.deleteFrom(
                "trading_job_commands",
                "DELETE FROM trading_job_commands " +
                    "WHERE job_id IN (" +
                    "SELECT job_id FROM trading_jobs WHERE chain_id = @chainId AND collection_id = @collectionId" +
                    ")",
            ),
            this.deleteFrom(
                "trading_bidding_job_runtime_state",
                "DELETE FROM trading_bidding_job_runtime_state " +
                    "WHERE job_id IN (" +
                    "SELECT job_id FROM trading_jobs WHERE chain_id = @chainId AND collection_id = @collectionId" +
                    ")",
            ),
            this.deleteFrom(
                "trading_bidding_job_specs",
                "DELETE FROM trading_bidding_job_specs " +
                    "WHERE job_id IN (" +
                    "SELECT job_id FROM trading_jobs WHERE chain_id = @chainId AND collection_id = @collectionId" +
                    ")",
            ),
            this.deleteFrom(
                "bootstrap_run_steps",
                "DELETE FROM bootstrap_run_steps " +
                    "WHERE run_id IN (" +
                    "SELECT run_id FROM bootstrap_runs WHERE chain_id = @chainId AND collection_id = @collectionId" +
                    ")",
            ),
            this.deleteCollectionRows(
                "metadata_refresh_extension_artifact_tasks",
            ),
            this.deleteCollectionRows("metadata_refresh_runs"),
            this.deleteCollectionRows("queue_outbox"),
            this.deleteCollectionRows("trading_bidding_bid_book_rows"),
            this.deleteCollectionRows(
                "trading_bidding_collection_bid_book_state",
            ),
            this.deleteCollectionRows(
                COLLECTION_PURGE_LATE_SCHEMA_TABLE.BiddingOrderCancellations,
            ),
            this.deleteCollectionRows("trading_bidding_price_tiers"),
            this.deleteCollectionRows("trading_jobs"),
            this.deleteCollectionRows("collection_extension_event_media"),
            this.deleteCollectionRows("collection_extension_events"),
            this.deleteCollectionRows("token_extension_artifacts"),
            this.deleteCollectionRows(
                COLLECTION_PURGE_LATE_SCHEMA_TABLE.SyntheticTokenRetirements,
            ),
            this.deleteCollectionRows("collection_extension_installs"),
            this.deleteCollectionRows("collection_customization_features"),
            this.deleteCollectionRows("collection_settings"),
            this.deleteCollectionRows("collection_scope_tokens"),
            this.deleteCollectionRows("collection_sync_blocks"),
            this.deleteCollectionRows("collection_trait_stats"),
            this.deleteCollectionRows("token_sets_tokens"),
            this.deleteCollectionRows("token_sets"),
            this.deleteCollectionRows("token_attributes"),
            this.deleteCollectionRows("attributes"),
            this.deleteCollectionRows("attribute_keys"),
            this.deleteCollectionRows("token_metadata"),
            this.deleteCollectionRows("token_image_cache"),
            this.deleteCollectionRows("tokens"),
            this.deleteCollectionRows("nft_balance_snapshots"),
            this.deleteCollectionRows("nft_balances"),
            this.deleteCollectionRows(
                "bootstrap_collection_extension_artifact_tasks",
            ),
            this.deleteCollectionRows("bootstrap_ownership_snapshot_tasks"),
            this.deleteCollectionRows("bootstrap_image_cache_tasks"),
            this.deleteCollectionRows("bootstrap_metadata_snapshot_tasks"),
            this.deleteCollectionRows("bootstrap_run_events"),
            this.deleteCollectionRows("bootstrap_runs"),
            this.deleteCollectionRows("opensea_orderbook_runs"),
            this.deleteCollectionRows("offchain_order_observations"),
            this.deleteCollectionRows("activities"),
            this.deleteCollectionRows("fills"),
            this.deleteCollectionRows("nft_transfer_events"),
            this.deleteCollectionRows("orders"),
            this.deleteCollectionRows("collections"),
        ];
    }

    purgeCollectionData(
        input: PurgeCollectionParams,
    ): PurgeCollectionDeletedRowCount[] {
        return db.raw.transaction((params: PurgeCollectionParams) => {
            const deletedRows = this.deleteStatements.map(
                ({ table, statement }) => ({
                    table,
                    rowCount: statement.run(params).changes,
                }),
            );

            // Verify every current collection_id-bearing table was cleared.
            this.assertNoCollectionScopedRowsRemain(params);
            return deletedRows;
        })(input);
    }

    private deleteCollectionRows(table: string): DeleteStatement {
        return this.deleteFrom(
            table,
            `DELETE FROM ${quoteIdentifier(table)} WHERE chain_id = @chainId AND collection_id = @collectionId`,
        );
    }

    private deleteFrom(table: string, sql: string): DeleteStatement {
        return {
            table,
            statement: db.prepare<PurgeCollectionParams>(
                sql,
            ) as BetterSqlite3NamedStatement<PurgeCollectionParams>,
        };
    }

    private assertNoCollectionScopedRowsRemain(
        params: PurgeCollectionParams,
    ): void {
        const tableRows = db
            .prepare<
                []
            >("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
            .all() as TableNameRow[];

        for (const row of tableRows) {
            const columns = db.raw.pragma(
                `table_info(${quoteIdentifier(row.name)})`,
            ) as TableColumnInfoRow[];
            const columnNames = new Set(columns.map((column) => column.name));
            if (!columnNames.has("collection_id")) continue;

            const where = columnNames.has("chain_id")
                ? "chain_id = @chainId AND collection_id = @collectionId"
                : "collection_id = @collectionId";
            const countRow = db
                .prepare<PurgeCollectionParams>(
                    `SELECT COUNT(1) AS count FROM ${quoteIdentifier(row.name)} WHERE ${where}`,
                )
                .get(params) as CountRow | undefined;
            if ((countRow?.count ?? 0) > 0) {
                throw new Error(`Collection purge left rows in ${row.name}`);
            }
        }
    }
}

function quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
}
