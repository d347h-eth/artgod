import type {
    BetterSqlite3Database,
    BetterSqlite3Statement,
} from "@artgod/shared/database";
import { statfsSync, statSync } from "node:fs";
import { stat, statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { ACTIVITY_KIND, ACTIVITY_SOURCE_KIND } from "@artgod/shared/types";
import {
    MARKET_DATA_STORAGE_POLICY as POLICY,
    MARKET_DATA_RECOVERY_STAGE as STAGE,
} from "@artgod/shared/market-data/storage-policy";
import type {
    MarketDataMaintenancePort,
    MarketDataRecoveryProgress,
    MarketDataCompactionResult,
} from "../../application/storage/maintain-market-data.js";
import {
    ORDER_RETIREMENT_REASON,
    orderRetirementReason,
    retirementMarkerExpiry,
} from "../../domain/order-retention.js";
import { ORDER_SOURCE_STATUS } from "../../domain/orders.js";
import { CURRENT_ASK_INDEX_SQL } from "@artgod/shared/database/current-asks";
import {
    MARKET_ORDER_CLEANUP_QUERIES,
    MARKET_ORDER_INDEX_SQL,
} from "./sqlite-market-order-queries.js";

type SqlRow = Record<string, string | number | null>;
type RecoveryRow = {
    stage: MarketDataRecoveryProgress["stage"];
    cursor: number;
    removed_rows: number;
};
const REBUILD_TABLE = {
    activities: "market_rebuild_activities",
    orders: "market_rebuild_orders",
} as const;
const OBSOLETE_MARKET_INDEXES = new Set([
    "activities_open_create_idx",
    "activities_order_idx",
    "activities_contract_token_idx",
    "activities_listing_expiry_idx",
    "activities_listing_group_idx",
    "orders_active_token_sell_lookup_idx",
    "orders_maker_revalidation_candidates_idx",
    "orders_maker_collection_revalidation_idx",
]);

/** Only used with producers/readers stopped during rebuild. Online maintenance never changes schema. */
export class SqliteMarketDataMaintenance implements MarketDataMaintenancePort {
    private cleanupQueries?: BetterSqlite3Statement[];
    private observationQuery?: BetterSqlite3Statement;
    private retirementInsert?: BetterSqlite3Statement;
    private deleteOrder?: BetterSqlite3Statement;
    private currentOrder?: BetterSqlite3Statement;
    private expiredMarkers?: BetterSqlite3Statement;
    private deleteMarker?: BetterSqlite3Statement;
    constructor(
        private readonly conn: BetterSqlite3Database,
        private readonly databasePath: string,
        private readonly availableBytes?: () => number,
    ) {}

    inspect(): MarketDataRecoveryProgress {
        const row = this.conn
            .prepare(
                "SELECT stage,cursor,removed_rows FROM market_data_recovery WHERE singleton=1",
            )
            .get() as RecoveryRow | undefined;
        if (!row || !Object.values(STAGE).includes(row.stage))
            throw new Error(
                "Missing or unsupported SQLite market-data recovery state",
            );
        return {
            stage: row.stage,
            cursor: row.cursor,
            removedRows: row.removed_rows,
        };
    }

    recoverBatch(now: number): MarketDataRecoveryProgress {
        this.requireHeadroom(POLICY.recoveryMinFreeBytes);
        const progress = this.inspect();
        switch (progress.stage) {
            case STAGE.ListingReset:
                // One-time alpha upgrade. Drop only obsolete bookkeeping/shadow
                // state here; the bounded copy below discards legacy listing rows.
                this.conn
                    .transaction(() => {
                        this.conn.exec(
                            "DROP TABLE IF EXISTS market_rebuild_activities;" +
                                "DROP TABLE IF EXISTS market_rebuild_orders;",
                        );
                        this.advance(STAGE.Activities);
                    })
                    .immediate();
                break;
            case STAGE.Activities:
            case STAGE.Orders:
                this.rebuildBatch(progress.stage, progress, now);
                break;
            case STAGE.Receipts:
                this.conn
                    .transaction(() => {
                        this.conn.exec("DROP TABLE IF EXISTS activity_sources");
                        this.advance(STAGE.Indexes);
                    })
                    .immediate();
                break;
            case STAGE.Indexes:
                this.conn
                    .transaction(() => {
                        this.conn.exec(
                            "DROP INDEX IF EXISTS activities_listing_expiry_idx;" +
                                "DROP INDEX IF EXISTS activities_listing_group_idx;" +
                                "DROP INDEX IF EXISTS orders_active_token_sell_lookup_idx;" +
                                "CREATE UNIQUE INDEX IF NOT EXISTS activities_daily_listing_idx ON activities(chain_id,collection_id,token_id,maker,listing_day) WHERE listing_day IS NOT NULL;" +
                                "CREATE INDEX IF NOT EXISTS orders_expiry_idx ON orders(valid_until) WHERE valid_until IS NOT NULL;",
                        );
                        this.conn.exec(CURRENT_ASK_INDEX_SQL);
                        this.conn.exec(MARKET_ORDER_INDEX_SQL);
                        this.advance(STAGE.Checkpoint);
                    })
                    .immediate();
                break;
            case STAGE.Checkpoint: {
                const checkpoint = this.checkpoint();
                if (checkpoint.busy)
                    throw new Error(
                        "Another database client is blocking startup recovery",
                    );
                // SQLite's bounded optimizer, not a full legacy-data ANALYZE.
                this.conn.pragma("optimize=0x10002");
                this.advance(STAGE.Complete);
                break;
            }
            case STAGE.Complete:
                break;
        }
        // Bound journal growth between batches. This is not VACUUM and never deletes a WAL by hand.
        if (progress.cursor % (POLICY.maintenanceBatchRows * 100) === 0)
            this.checkpoint();
        return this.inspect();
    }

    private rebuildBatch(
        table: keyof typeof REBUILD_TABLE,
        progress: MarketDataRecoveryProgress,
        now: number,
    ): void {
        const replacement = REBUILD_TABLE[table];
        const schema = this.conn
            .prepare(
                "SELECT sql FROM sqlite_schema WHERE type='table' AND name=?",
            )
            .get(table) as { sql: string };
        // Reuse the actual migrated column/constraint schema, including future additive columns.
        const replacementSql = schema.sql.replace(
            /^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"[^"]+"|\w+)/i,
            `CREATE TABLE IF NOT EXISTS ${replacement}`,
        );
        this.conn.exec(replacementSql);
        const columns = this.conn.pragma(`table_info(${table})`) as {
            name: string;
        }[];
        const names = columns.map(({ name }) => quote(name));
        const insert = this.conn.prepare(
            `INSERT INTO ${replacement} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})` +
                (table === "activities"
                    ? " ON CONFLICT(chain_id,dedupe_key) DO NOTHING"
                    : ""),
        );
        // The transaction snapshots collection admission together with copy progress.
        this.conn
            .transaction(() => {
                const rows = this.conn
                    .prepare(
                        `SELECT rowid AS recovery_rowid,* FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT ?`,
                    )
                    .all(
                        progress.cursor,
                        POLICY.maintenanceBatchRows,
                    ) as SqlRow[];
                if (!rows.length) {
                    const definitions = this.conn
                        .prepare(
                            "SELECT type,name,sql FROM sqlite_schema WHERE tbl_name=? AND sql IS NOT NULL AND type IN ('index','trigger')",
                        )
                        .all(table) as {
                        type: string;
                        name: string;
                        sql: string;
                    }[];
                    const sequence =
                        table === "activities"
                            ? (this.conn
                                  .prepare(
                                      "SELECT seq FROM sqlite_sequence WHERE name=?",
                                  )
                                  .get(table) as { seq: number } | undefined)
                            : undefined;
                    this.conn.exec(
                        `DROP TABLE ${table}; ALTER TABLE ${replacement} RENAME TO ${table};`,
                    );
                    if (sequence) {
                        this.conn
                            .prepare(
                                "INSERT INTO sqlite_sequence(name,seq) SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name=?)",
                            )
                            .run(table, sequence.seq, table);
                        this.conn
                            .prepare(
                                "UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name=?",
                            )
                            .run(sequence.seq, table);
                    }
                    for (const definition of definitions) {
                        if (OBSOLETE_MARKET_INDEXES.has(definition.name))
                            continue;
                        let sql = definition.sql;
                        if (
                            [
                                "activities_collection_extension_event_feed_idx",
                                "activities_collection_content_hash_feed_idx",
                                "activities_collection_event_group_feed_idx",
                            ].includes(definition.name) &&
                            !/\bWHERE\b/i.test(sql)
                        )
                            sql += " WHERE kind='custom'";
                        this.conn.exec(sql);
                    }
                    this.advance(
                        table === "activities" ? STAGE.Orders : STAGE.Receipts,
                    );
                    return;
                }
                let removed = 0;
                const collectionExists = this.conn.prepare(
                    "SELECT 1 FROM collections WHERE chain_id=? AND collection_id=?",
                );
                for (const row of rows) {
                    if (
                        !collectionExists.get(row.chain_id, row.collection_id)
                    ) {
                        removed++;
                        continue;
                    }
                    if (table === "activities") {
                        // Legacy listing history may be reset. New daily rows are
                        // permanent and must survive later repair/restart passes.
                        if (
                            (row.kind === ACTIVITY_KIND.ListingCreated &&
                                (row.listing_day === null ||
                                    row.listing_price_at === null)) ||
                            (row.source_kind ===
                                ACTIVITY_SOURCE_KIND.Offchain &&
                                row.kind !== ACTIVITY_KIND.ListingCreated)
                        ) {
                            removed++;
                            continue;
                        }
                    } else {
                        if (this.retire(row, now)) {
                            removed++;
                            continue;
                        }
                        row.observed_at =
                            Number(row.observed_at) || epoch(row.updated_at);
                        row.protocol_address = protocolAddress(
                            row.seaport_data_json,
                        );
                    }
                    const result = insert.run(
                        ...columns.map(({ name }) => row[name]),
                    );
                    if (!result.changes) removed++;
                }
                this.conn
                    .prepare(
                        "UPDATE market_data_recovery SET cursor=?,removed_rows=removed_rows+?,updated_at=? WHERE singleton=1",
                    )
                    .run(rows[rows.length - 1]!.recovery_rowid, removed, now);
            })
            .immediate();
    }

    /** Select due work without a writer lock. The runtime bounds the whole pass;
     * startup uses its separate legacy-rebuild path, not this online loop. */
    maintainBatch(now: number): number {
        this.cleanupQueries ??= MARKET_ORDER_CLEANUP_QUERIES.map((sql) =>
            this.conn.prepare(sql),
        );
        this.expiredMarkers ??= this.conn.prepare(
            "SELECT chain_id,order_id FROM market_order_retirements WHERE expires_at<=? ORDER BY expires_at LIMIT ?",
        );
        this.deleteOrder ??= this.conn.prepare("DELETE FROM orders WHERE id=?");
        this.currentOrder ??= this.conn.prepare(
            "SELECT id,chain_id,collection_id,valid_until,source_status,fillability_status,observed_at,updated_at,block_number FROM orders WHERE id=?",
        );
        this.deleteMarker ??= this.conn.prepare(
            "DELETE FROM market_order_retirements WHERE chain_id=? AND order_id=? AND expires_at<=?",
        );
        const candidates = new Map<string, SqlRow>();
        for (const query of this.cleanupQueries) {
            const limit = POLICY.maintenanceBatchRows - candidates.size;
            if (!limit) break;
            for (const row of query.all({
                now,
                terminalBefore: now - POLICY.orderReorgGraceSeconds,
                inactiveBefore: now - POLICY.inactiveOrderGraceSeconds,
                unknownBefore: now - POLICY.unknownOrderLifetimeSeconds,
                limit,
            }) as SqlRow[])
                candidates.set(String(row.id), row);
        }
        const markers = this.expiredMarkers.all(
            now,
            POLICY.maintenanceBatchRows,
        ) as { chain_id: number; order_id: string }[];
        if (!candidates.size && !markers.length) return 0;
        return this.conn
            .transaction(() => {
                const rows = [...candidates.values()];
                for (const row of rows) {
                    // Recheck after acquiring the writer lock: a runtime's
                    // reconcile may have refreshed the selected row meanwhile.
                    const current = this.currentOrder!.get(row.id) as
                        | SqlRow
                        | undefined;
                    if (current && this.retire(current, now))
                        this.deleteOrder!.run(row.id);
                }
                for (const marker of markers)
                    this.deleteMarker!.run(
                        marker.chain_id,
                        marker.order_id,
                        now,
                    );
                // Nonzero while either family makes progress, including an empty orderbook.
                return rows.length + markers.length;
            })
            .immediate();
    }

    private retire(row: SqlRow, now: number): boolean {
        this.observationQuery ??= this.conn.prepare(
            "SELECT observed_at FROM market_order_observations WHERE chain_id=? AND collection_id=?",
        );
        const observation = this.observationQuery.get(
            row.chain_id,
            row.collection_id,
        ) as { observed_at: number } | undefined;
        const input = {
            validUntil:
                row.valid_until === null ? null : Number(row.valid_until),
            sourceStatus: String(row.source_status),
            fillabilityStatus: String(row.fillability_status),
            lastObservedAt: Math.max(
                Number(row.observed_at) || epoch(row.updated_at),
                observation?.observed_at ?? 0,
            ),
            lastChangedAt: epoch(row.updated_at),
        };
        const reason = orderRetirementReason(input, now);
        if (
            reason === ORDER_RETIREMENT_REASON.Terminal ||
            (reason === ORDER_RETIREMENT_REASON.Stale &&
                row.source_status === ORDER_SOURCE_STATUS.Inactive)
        ) {
            this.retirementInsert ??= this.conn.prepare(
                "INSERT INTO market_order_retirements(chain_id,collection_id,order_id,expires_at,block_number,retired_at,reason) VALUES (?,?,?,?,?,?,?) ON CONFLICT(chain_id,order_id) DO NOTHING",
            );
            this.retirementInsert.run(
                row.chain_id,
                row.collection_id,
                row.id,
                reason === ORDER_RETIREMENT_REASON.Terminal
                    ? retirementMarkerExpiry(input, now)
                    : now + POLICY.unknownOrderLifetimeSeconds,
                row.block_number,
                input.lastObservedAt,
                row.source_status === ORDER_SOURCE_STATUS.Cancelled
                    ? ORDER_RETIREMENT_REASON.SourceCancelled
                    : reason,
            );
        }
        return reason !== null;
    }

    checkpoint(): { busy: number; log: number; checkpointed: number } {
        return (
            this.conn.pragma("wal_checkpoint(TRUNCATE)") as {
                busy: number;
                log: number;
                checkpointed: number;
            }[]
        )[0]!;
    }

    compactIfSafe(): MarketDataCompactionResult {
        if (this.inspect().stage !== STAGE.Complete)
            throw new Error("Logical recovery must complete before compaction");
        const beforeBytes = statSync(this.databasePath).size;
        const skipped = (reason: string): MarketDataCompactionResult => ({
            compacted: false,
            reason,
            beforeBytes,
            afterBytes: beforeBytes,
            reclaimedBytes: 0,
        });
        const prior = this.conn
            .prepare(
                "SELECT attempted FROM market_data_compaction WHERE singleton=1",
            )
            .get() as { attempted: number };
        if (prior.attempted) return skipped("already-attempted");
        if (this.checkpoint().busy) return skipped("checkpoint-busy");
        const pageSize = Number(
            this.conn.pragma("page_size", { simple: true }),
        );
        const pages = Number(this.conn.pragma("page_count", { simple: true }));
        const free = Number(
            this.conn.pragma("freelist_count", { simple: true }),
        );
        if (free * pageSize < POLICY.compactionMinReclaimBytes)
            return skipped("little-reclaimable-space");
        // Conservative live-image estimate plus WAL/temporary headroom. This is
        // a preflight, not a reservation: SQLite may still encounter disk-full.
        const required =
            3 * (pages - free) * pageSize + POLICY.recoveryMinFreeBytes;
        if (this.freeBytes() < required)
            return skipped("insufficient-compaction-headroom");
        this.conn.exec(
            "UPDATE market_data_compaction SET attempted=1 WHERE singleton=1",
        );
        if (this.checkpoint().busy) return skipped("checkpoint-busy");
        this.conn.exec("VACUUM");
        const checkpoint = this.checkpoint();
        if (checkpoint.busy || checkpoint.log !== checkpoint.checkpointed)
            throw new Error(
                "Compaction committed but its checkpoint is blocked; filesystem reclamation is not confirmed",
            );
        const afterBytes = statSync(this.databasePath).size;
        this.conn.exec(
            "UPDATE market_data_compaction SET completed=1 WHERE singleton=1",
        );
        this.checkpoint();
        return {
            compacted: true,
            beforeBytes,
            afterBytes,
            reclaimedBytes: Math.max(0, beforeBytes - afterBytes),
        };
    }

    /** Filesystem metadata only: never runs SQL or a checkpoint on the worker. */
    async observeWal() {
        let walBytes = 0;
        try {
            walBytes = (await stat(`${this.databasePath}-wal`)).size;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const fs = this.availableBytes
            ? null
            : await statfs(dirname(this.databasePath));
        const freeBytes = this.availableBytes
            ? this.availableBytes()
            : fs!.bavail * fs!.bsize;
        return { walBytes, freeBytes };
    }

    private advance(stage: MarketDataRecoveryProgress["stage"]): void {
        this.conn
            .prepare(
                "UPDATE market_data_recovery SET stage=?,cursor=0 WHERE singleton=1",
            )
            .run(stage);
    }
    private freeBytes(): number {
        if (this.availableBytes) return this.availableBytes();
        const fs = statfsSync(dirname(this.databasePath));
        return fs.bavail * fs.bsize;
    }
    private requireHeadroom(bytes: number): void {
        if (this.freeBytes() < bytes)
            throw new Error(
                "Insufficient disk space for a safe SQLite recovery batch",
            );
    }
}

function quote(name: string): string {
    return `"${name.replaceAll('"', '""')}"`;
}
function epoch(value: SqlRow[string] | undefined): number {
    if (typeof value === "number") return value;
    return value
        ? Math.floor(
              Date.parse(
                  value.replace(" ", "T") + (value.endsWith("Z") ? "" : "Z"),
              ) / 1000,
          ) || 0
        : 0;
}
function protocolAddress(value: SqlRow[string] | undefined): string | null {
    if (typeof value !== "string") return null;
    try {
        const result = JSON.parse(value)?.protocolAddress;
        return typeof result === "string" ? result.toLowerCase() : null;
    } catch {
        return null;
    }
}
