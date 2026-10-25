import { db, type BetterSqlite3NamedStatement } from "./db.js";
export type CollectionDeletedRowCount = { table: string; rowCount: number };

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

// Reorg invalidation discards derived data, not operator intent, cancellation
// obligations, or the failed run's diagnostic history. Full purge removes both.
const INVALIDATION_RETAINED_TABLES = new Set([
    "collections",
    "collection_scope_tokens",
    "collection_extension_installs",
    "collection_customization_features",
    "collection_settings",
    "bootstrap_runs",
    "bootstrap_run_events",
    "bootstrap_run_steps",
    "trading_jobs",
    "trading_job_commands",
    "trading_bidding_job_specs",
    "trading_bidding_job_runtime_state",
    "trading_bidding_order_cancellations",
    "trading_bidding_competition_presets",
]);

// Collection-scoped tables added after the original purge path need explicit deletes.
export const COLLECTION_PURGE_LATE_SCHEMA_TABLE = {
    SyntheticTokenRetirements:
        "collection_extension_synthetic_token_retirements",
    BiddingOrderCancellations: "trading_bidding_order_cancellations",
} as const;

// SqliteCollectionDataCleanup owns the destructive collection-scoped delete transaction.
export class SqliteCollectionDataCleanup {
    private readonly deleteStatements: DeleteStatement[];

    constructor() {
        this.deleteStatements = [
            ...(db
                .prepare<[string]>("SELECT 1 FROM sqlite_schema WHERE name=?")
                .get("activity_sources")
                ? [
                      this.deleteFrom(
                          "activity_sources",
                          "DELETE FROM activity_sources " +
                              "WHERE activity_id IN (" +
                              "SELECT id FROM activities WHERE chain_id = @chainId AND collection_id = @collectionId" +
                              ")",
                      ),
                  ]
                : []),
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
            // Collection scopes cannot survive their projection's invalidation;
            // global maker scopes still serve other collections on the chain.
            this.deleteFrom(
                "maker_order_revalidation_runs",
                "DELETE FROM maker_order_revalidation_runs WHERE chain_id=@chainId AND scope_collection_id=@collectionId",
            ),
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
            this.deleteCollectionRows("collection_sync_progress"),
            this.deleteCollectionRows("collection_sync_gap_scans"),
            this.deleteCollectionRows("erc721_ownership_checkpoints"),
            this.deleteCollectionRows("order_source_observations"),
            this.deleteCollectionRows(
                "trading_bidding_runtime_authorized_collections",
            ),
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
            this.deleteCollectionRows("market_order_retirements"),
            this.deleteCollectionRows("market_order_observations"),
            this.deleteCollectionRows("fills"),
            // A cross-collection execution must retain all raw legs while any
            // other collection still refers to it. Items cascade with the header.
            this.deleteFrom(
                "fill_executions",
                "DELETE FROM fill_executions WHERE chain_id=@chainId AND NOT EXISTS (SELECT 1 FROM fills WHERE fills.execution_id=fill_executions.id)",
            ),
            this.deleteCollectionRows("nft_transfer_events"),
            this.deleteCollectionRows("orders"),
            this.deleteCollectionRows("collections"),
        ];
    }

    purgeCollectionData(
        input: PurgeCollectionParams,
    ): CollectionDeletedRowCount[] {
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

    // Caller owns the lifecycle/recovery transaction. Keep its failed run and
    // configuration while removing everything a fresh bootstrap must replace.
    invalidateCollectionData(input: PurgeCollectionParams): void {
        if (!db.raw.inTransaction)
            throw new Error(
                "Collection invalidation requires its lifecycle writer",
            );
        for (const { table, statement } of this.deleteStatements) {
            if (!INVALIDATION_RETAINED_TABLES.has(table)) statement.run(input);
        }
        this.assertNoCollectionScopedRowsRemain(
            input,
            INVALIDATION_RETAINED_TABLES,
        );
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
        retained: ReadonlySet<string> = new Set(),
    ): void {
        const tableRows = db
            .prepare<
                []
            >("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
            .all() as TableNameRow[];

        for (const row of tableRows) {
            if (retained.has(row.name)) continue;
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
