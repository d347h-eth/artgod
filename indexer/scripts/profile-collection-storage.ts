import { resolve } from "node:path";
import { db, setDbPath } from "@artgod/shared/database";
import { SqliteCollectionsReadModel } from "@artgod/shared/read-models/collections";
import { NOOP_APM, type ApmPort } from "@artgod/shared/observability/apm";

/** Copy-only profiler. Wrap with an external timeout: synchronous SQLite cannot run a JS timer. */
const [path, collectionIdValue] = process.argv.slice(2);
if (!path || !collectionIdValue || !process.argv.includes("--copied-db"))
    throw new Error(
        "Usage: profile-collection-storage.ts <copy> <collection-id> --copied-db [--plan-only]",
    );
setDbPath(resolve(path));
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
    if (process.argv.includes("--plan-only")) {
        const prepare = conn.prepare.bind(conn);
        // Compile the actual production SQL/bindings, but never execute its reads.
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
        })) as typeof conn.prepare;
    }
    const reader = new SqliteCollectionsReadModel(
        [
            "0x0000000000000000000000000000000000000000",
            "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        ],
        apm,
    );
    const result = reader.listCollectionTokens({
        chainId: 1,
        collectionId: Number(collectionIdValue),
        tokenStatus: "listed",
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
