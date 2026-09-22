import { zeroAddress } from "viem";
import { TOKEN_BROWSER_STATUS } from "@artgod/shared/types/browse";
import { parseStorageProfileArgs } from "./sqlite-storage-cli.js";
import { db, setDbPath } from "@artgod/shared/database";
import { SqliteCollectionsReadModel } from "@artgod/shared/read-models/collections";
import { NOOP_APM, type ApmPort } from "@artgod/shared/observability/apm";

/** Copy-only profiler. Wrap with an external timeout: synchronous SQLite cannot run a JS timer. */
const config = parseStorageProfileArgs(process.argv.slice(2));
setDbPath(config.databasePath);
const conn = db.raw;
conn.pragma("query_only=ON");
const emit = (value: unknown) =>
    process.stdout.write(`${JSON.stringify(value)}\n`);
const apm: ApmPort = {
    ...NOOP_APM,
    withSyncSpan(name, attributes, run) {
        const start = performance.now();
        emit({ event: "span-start", name, attributes });
        try {
            return run();
        } finally {
            emit({
                event: "span-end",
                name,
                milliseconds: performance.now() - start,
            });
        }
    },
};
try {
    if (config.planOnly) {
        const prepare = conn.prepare.bind(conn);
        // Compile the actual production SQL/bindings, but never execute its reads.
        // The read model uses only these methods of the statement contract.
        conn.prepare = ((sql: string) => ({
            run: () => {
                throw new Error("Profiler cannot execute writes");
            },
            all: (...values: unknown[]) => {
                emit({
                    sql,
                    plan: prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values),
                });
                return [];
            },
            get: (...values: unknown[]) => {
                emit({
                    sql,
                    plan: prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values),
                });
                return { count: 0 };
            },
        })) as unknown as typeof conn.prepare;
    }
    const reader = new SqliteCollectionsReadModel(
        [zeroAddress, config.wethAddress],
        apm,
    );
    const result = reader.listCollectionTokens({
        chainId: config.chainId,
        collectionId: config.collectionId,
        tokenStatus: TOKEN_BROWSER_STATUS.Listed,
        limit: 100,
    });
    emit({
        event: "result",
        items: result.items.length,
        totalItems: result.totalItems,
    });
} finally {
    conn.close();
}
