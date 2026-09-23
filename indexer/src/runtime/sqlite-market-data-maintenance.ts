import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { MaintainMarketData } from "../application/storage/maintain-market-data.js";
import { CompactMarketData } from "../application/storage/compact-market-data.js";
import { logger } from "@artgod/shared/utils";
import runtime from "@artgod/shared/market-data/recovery-runtime" with { type: "json" };
import { SqliteMarketDataMaintenance } from "../infra/storage/sqlite-market-data-maintenance.js";
import { loadSqliteMarketDataMaintenanceConfig } from "../config/sqlite-market-data-maintenance.js";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

async function main(): Promise<void> {
    const config = loadSqliteMarketDataMaintenanceConfig();
    // Recovery scratch space is app/database-owned, never an implicit OS temp directory.
    const scratch = join(dirname(resolve(config.databasePath)), "tmp");
    mkdirSync(scratch, { recursive: true });
    process.env.SQLITE_TMPDIR = scratch;
    setDbPath(config.databasePath);
    const conn = db.raw;
    const abort = new AbortController();
    const stop = () => abort.abort(new Error("SQLite maintenance stopped"));
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    try {
        await createMigrationRunner().runMigrations();
        const storage = new SqliteMarketDataMaintenance(db);
        const compaction = new CompactMarketData(storage);
        const compact = () =>
            logger.info("SQLite storage compaction completed", {
                component: runtime.logComponent,
                action: runtime.logActions.compacted,
                compaction: compaction.execute(),
            });
        if (config.compactOnly) {
            abort.signal.throwIfAborted();
            compact();
            return;
        }
        const maintenance = new MaintainMarketData(storage, {
            report: (progress) =>
                logger.info("SQLite market-data recovery progress", {
                    component: runtime.logComponent,
                    action: runtime.logActions.progress,
                    ...progress,
                }),
        });
        const progress = await maintenance.recover(abort.signal);
        logger.info("SQLite market-data recovery completed", {
            component: runtime.logComponent,
            action: runtime.logActions.completed,
            recovery: progress,
        });
        // Physical shrinking is a separate stage, never required for logical readiness.
        if (config.compact) {
            abort.signal.throwIfAborted();
            compact();
        }
    } finally {
        conn.close();
        process.removeListener("SIGTERM", stop);
        process.removeListener("SIGINT", stop);
    }
}

main().catch((error) => {
    logger.error("SQLite market-data maintenance failed", {
        component: runtime.logComponent,
        action: runtime.logActions.failed,
        error: String(error),
    });
    process.exitCode = 1;
});
