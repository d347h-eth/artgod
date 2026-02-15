import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "@artgod/shared/utils/paths";

export type BetterSqlite3Database = Database.Database;
// better-sqlite3 types only model positional (tuple) bind parameters.
// We keep this alias for statements that use "?" placeholders.
export type BetterSqlite3Statement<TArgs extends unknown[] = unknown[]> =
    Database.Statement<TArgs>;
export type BetterSqlite3NamedStatement<
    TParams extends Record<string, unknown>,
> = Omit<
    Database.Statement<any>,
    "run" | "get" | "all" | "iterate" | "bind"
> & {
    // Named placeholders (eg "@id") are supported by SQLite, but not typed in
    // @types/better-sqlite3. This wrapper gives us a typed object contract.
    run(params: TParams): Database.RunResult;
    get(params: TParams): unknown | undefined;
    all(params: TParams): unknown[];
    iterate(params: TParams): IterableIterator<unknown>;
    bind(params: TParams): BetterSqlite3NamedStatement<TParams>;
};

let currentDb: BetterSqlite3Database | null = null;
let currentPath: string | null = null;

function applyPragmas(conn: BetterSqlite3Database) {
    conn.pragma("journal_mode = WAL");
    conn.pragma("synchronous = NORMAL");
    conn.pragma("foreign_keys = ON");
    conn.pragma("busy_timeout = 5000");
}

function ensureConnection(): BetterSqlite3Database {
    if (!currentDb) {
        if (!currentPath) {
            throw new Error(
                "Database path not configured. Call setDbPath(...) during startup.",
            );
        }
        try {
            fs.mkdirSync(path.dirname(currentPath), { recursive: true });
        } catch {}
        const db = new Database(currentPath);
        applyPragmas(db);
        currentDb = db;
    }
    return currentDb;
}

export function setDbPath(newPath: string): void {
    if (currentDb) {
        try {
            currentDb.close();
        } catch {}
        currentDb = null;
    }
    currentPath = resolveDbPath(newPath);
}

function resolveDbPath(pathValue: string): string {
    if (path.isAbsolute(pathValue)) return pathValue;
    return resolveProjectPath(pathValue);
}

// Positional binds: const stmt = db.prepare<[id: string]>("... ? ...");
function prepare<T extends unknown[]>(sql: string): BetterSqlite3Statement<T>;
// Named binds: const stmt = db.prepare<{id: string}>("... @id ...");
function prepare<T extends Record<string, unknown>>(
    sql: string,
): BetterSqlite3NamedStatement<T>;
function prepare(sql: string): Database.Statement<any> {
    // Single implementation for both overloads.
    return ensureConnection().prepare(sql);
}

export const db = {
    exec(sql: string): void {
        ensureConnection().exec(sql);
    },
    // Use `prepare` for any SQL statement; it returns typed statements
    // for both positional and named parameter styles.
    prepare,
    get raw(): BetterSqlite3Database {
        return ensureConnection();
    },
};
