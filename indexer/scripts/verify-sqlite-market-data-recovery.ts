import { createHash } from "node:crypto";
import { statSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import { zeroAddress } from "viem";
import { TOKEN_BROWSER_STATUS } from "@artgod/shared/types/browse";
import runtime from "@artgod/shared/market-data/recovery-runtime" with { type: "json" };
import { parseStorageVerificationArgs } from "./sqlite-storage-cli.js";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
    db,
    setDbPath,
    type BetterSqlite3Database,
} from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { MaintainMarketData } from "../src/application/storage/maintain-market-data.js";
import { CompactMarketData } from "../src/application/storage/compact-market-data.js";
import { SqliteMarketDataMaintenance } from "../src/infra/storage/sqlite-market-data-maintenance.js";
import { SqliteCollectionsReadModel } from "@artgod/shared/read-models/collections";
import { MARKET_DATA_STORAGE_POLICY as POLICY } from "@artgod/shared/market-data/storage-policy";

/** Explicit, reusable destructive QA on a user-provided COPY, never an implicit app-data path. */
async function main() {
    const config = parseStorageVerificationArgs(process.argv.slice(2));
    const { databasePath, runtimeRoot } = config;
    const started = performance.now();
    setDbPath(databasePath);
    // Resolve the QA driver's explicit root-workspace dependency. The bundled
    // child independently resolves its staged native dependency without PnP.
    const Database = createRequire(
        new URL("../../package.json", import.meta.url),
    )("better-sqlite3") as new (
        path: string,
        options: { readonly: boolean; fileMustExist: boolean },
    ) => BetterSqlite3Database;
    let conn = runtimeRoot
        ? new Database(databasePath, { readonly: true, fileMustExist: true })
        : db.raw;
    try {
        if (!runtimeRoot) await createMigrationRunner().runMigrations();
        const excluded = new Set([
            "orders",
            "activities",
            "activity_sources",
            "migrations",
            "market_data_recovery",
            "market_data_compaction",
            "market_order_retirements",
            "market_order_observations",
        ]);
        const tables = (
            conn
                .prepare(
                    "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'market_rebuild_%' ORDER BY name",
                )
                .all() as { name: string }[]
        )
            .map((r) => r.name)
            .filter((n) => !excluded.has(n));
        function fingerprint() {
            return Object.fromEntries(
                tables.map((table) => {
                    const hash = createHash("sha256");
                    let count = 0;
                    // One row at a time, including artifact bytes; no whole-table JS allocation.
                    for (const row of conn
                        .prepare(
                            `SELECT * FROM "${table.replaceAll('"', '""')}"`,
                        )
                        .iterate()) {
                        hash.update(JSON.stringify(row));
                        hash.update("\n");
                        count++;
                    }
                    return [table, { count, sha256: hash.digest("hex") }];
                }),
            );
        }
        function allocation() {
            return {
                fileBytes: statSync(databasePath).size,
                pageCount: conn.pragma("page_count", { simple: true }),
                freelistPages: conn.pragma("freelist_count", { simple: true }),
                pageSize: conn.pragma("page_size", { simple: true }),
            };
        }
        function measureCollectionReads(phase: string) {
            // Main-page dependencies, separately from activity pagination. No RPC or live services.
            const reader = new SqliteCollectionsReadModel([
                zeroAddress,
                config.wethAddress,
            ]);
            for (const collection of conn
                .prepare(
                    "SELECT chain_id,collection_id,slug FROM collections WHERE chain_id=?",
                )
                .all(config.chainId) as {
                chain_id: number;
                collection_id: number;
                slug: string;
            }[]) {
                for (const [query, run] of [
                    [
                        "collection",
                        () =>
                            reader.resolveCollectionRef(
                                collection.chain_id,
                                collection.slug,
                            ),
                    ],
                    [
                        "asks",
                        () =>
                            reader.listCollectionTokens({
                                chainId: collection.chain_id,
                                collectionId: collection.collection_id,
                                tokenStatus: TOKEN_BROWSER_STATUS.Listed,
                                limit: 100,
                            }),
                    ],
                    [
                        "facets",
                        () =>
                            reader.listCollectionTraitFacets(
                                collection.chain_id,
                                collection.collection_id,
                            ),
                    ],
                ] as const) {
                    const start = performance.now();
                    run();
                    process.stdout.write(
                        `${JSON.stringify({ event: "read-timing", phase, chainId: collection.chain_id, collectionId: collection.collection_id, query, milliseconds: performance.now() - start })}\n`,
                    );
                }
            }
        }
        const before = fingerprint();
        process.stdout.write(
            `${JSON.stringify({ event: "before", allocation: allocation(), preserved: before })}\n`,
        );
        if (!config.skipReadBaseline) measureCollectionReads("before");
        if (runtimeRoot) {
            // The production child is the only open SQLite connection while it
            // migrates/recovers; it uses staged dependencies, not Yarn/PnP.
            conn.close();
            await runBundled(runtimeRoot, databasePath, config.compact);
            setDbPath(databasePath);
            conn = db.raw;
        } else {
            const maintenance = new SqliteMarketDataMaintenance(db);
            await new MaintainMarketData(maintenance, {
                report: (progress) =>
                    process.stdout.write(
                        `${JSON.stringify({ event: "progress", elapsedSeconds: (performance.now() - started) / 1000, ...progress })}\n`,
                    ),
            }).recover();
            process.stdout.write(
                `${JSON.stringify({ event: "logical-recovery", allocation: allocation() })}\n`,
            );
            if (config.compact) {
                const fs = statfsSync(dirname(databasePath));
                process.stdout.write(
                    `${JSON.stringify({ event: "compaction", availableBytes: fs.bavail * fs.bsize, ...new CompactMarketData(maintenance).execute() })}\n`,
                );
            }
        }
        const after = fingerprint();
        measureCollectionReads("after");
        if (JSON.stringify(before) !== JSON.stringify(after))
            throw new Error(
                "Protected-table fingerprints changed during market-data recovery",
            );
        const integrity = conn.pragma("quick_check", { simple: true });
        if (integrity !== "ok")
            throw new Error(`SQLite quick_check: ${integrity}`);
        process.stdout.write(
            `${JSON.stringify({ event: "verified", elapsedSeconds: (performance.now() - started) / 1000, allocation: allocation(), integrity, preserved: after, orders: conn.prepare("SELECT COUNT(*) AS count FROM orders").get(), activities: conn.prepare("SELECT kind,COUNT(*) AS count FROM activities GROUP BY kind").all() })}\n`,
        );
    } finally {
        if (conn.open) conn.close();
    }
}

async function runBundled(
    runtimeRoot: string,
    databasePath: string,
    compact: boolean,
): Promise<void> {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        ARTGOD_WORKSPACE_ROOT: runtimeRoot,
        ARTGOD_DB_PATH: databasePath,
    };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    await new Promise<void>((resolveRun, reject) => {
        const child = spawn(
            join(
                runtimeRoot,
                "node",
                process.platform === "win32" ? "node.exe" : "node",
            ),
            [
                join(
                    runtimeRoot,
                    "indexer/dist-desktop/sqlite-market-data-maintenance.mjs",
                ),
                ...(compact ? [runtime.cliArguments.compact] : []),
            ],
            { cwd: runtimeRoot, env, stdio: "inherit" },
        );
        let stopped = false;
        let forceStop: ReturnType<typeof setTimeout> | undefined;
        const stop = () => {
            if (stopped) return;
            stopped = true;
            child.kill("SIGTERM");
            forceStop = setTimeout(() => child.kill("SIGKILL"), 10_000);
        };
        const deadline = setTimeout(stop, POLICY.recoveryBudgetMs);
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        const cleanup = () => {
            clearTimeout(deadline);
            clearTimeout(forceStop);
            process.removeListener("SIGINT", stop);
            process.removeListener("SIGTERM", stop);
        };
        child.once("error", (error) => {
            cleanup();
            reject(error);
        });
        child.once("exit", (code, signal) => {
            cleanup();
            code === 0 && !stopped
                ? resolveRun()
                : reject(
                      new Error(
                          `Bundled recovery exited ${code ?? signal}${stopped ? " after cancellation/deadline" : ""}`,
                      ),
                  );
        });
    });
}
main().catch((error) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
});
