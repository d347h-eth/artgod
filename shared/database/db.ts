import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "@artgod/shared/utils/paths";

export type BetterSqlite3Database = Database.Database;
export type BetterSqlite3Statement<TArgs extends any[] = any[]> =
    Database.Statement<TArgs>;

let currentDb: BetterSqlite3Database | null = null;
let currentPath = resolveProjectPath("database/sqlite/sqlite");

function applyPragmas(conn: BetterSqlite3Database) {
    conn.pragma("journal_mode = WAL");
    conn.pragma("synchronous = NORMAL");
    conn.pragma("foreign_keys = ON");
    conn.pragma("busy_timeout = 5000");
}

function ensureConnection(): BetterSqlite3Database {
    if (!currentDb) {
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
    currentPath = newPath;
}

export const db = {
    exec(sql: string): void {
        ensureConnection().exec(sql);
    },
    prepare<T extends any[]>(sql: string): BetterSqlite3Statement<T> {
        return ensureConnection().prepare(
            sql,
        ) as unknown as Database.Statement<T>;
    },
    get raw(): BetterSqlite3Database {
        return ensureConnection();
    },
};
