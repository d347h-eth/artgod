import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "@artgod/shared/utils/paths";
import { SQLITE_STORAGE_POLICY } from "./storage-policy.js";

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

// SQLite waits this long inside one lock acquisition before reporting SQLITE_BUSY.
const SQLITE_BUSY_TIMEOUT_MS = 5_000;

// Defines the bounded retry budget for transient cross-process SQLite contention.
export const SQLITE_BUSY_RETRY_POLICY = Object.freeze({
    maxAttempts: 3,
    baseDelayMs: 10,
});

// Extended busy result codes retain the SQLITE_BUSY prefix.
const SQLITE_BUSY_ERROR_CODE = "SQLITE_BUSY";
const sqliteBusyRetryWaitState = new Int32Array(
    new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
);

type SynchronousTransactionGuard<TResult> = [
    Extract<TResult, PromiseLike<unknown>>,
] extends [never]
    ? unknown
    : never;

function applyPragmas(conn: BetterSqlite3Database): void {
    conn.pragma("journal_mode = WAL");
    conn.pragma("synchronous = NORMAL");
    conn.pragma("foreign_keys = ON");
    conn.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    // Caps recycled journal allocation after a successful checkpoint, not outstanding WAL work.
    conn.pragma(
        `journal_size_limit = ${SQLITE_STORAGE_POLICY.journalSizeLimitBytes}`,
    );
}

function isSqliteBusyError(error: unknown): boolean {
    if (typeof error !== "object" || error === null || !("code" in error)) {
        return false;
    }
    const code = Reflect.get(error, "code");
    return (
        typeof code === "string" &&
        (code === SQLITE_BUSY_ERROR_CODE ||
            code.startsWith(`${SQLITE_BUSY_ERROR_CODE}_`))
    );
}

function getSqliteBusyRetryDelayMs(attempt: number): number {
    return SQLITE_BUSY_RETRY_POLICY.baseDelayMs * 2 ** (attempt - 1);
}

function waitForSqliteBusyRetry(delayMs: number): void {
    Atomics.wait(sqliteBusyRetryWaitState, 0, 0, delayMs);
}

// Retries only cross-connection SQLite contention with a small bounded backoff.
function executeWithSqliteBusyRetry<T>(
    operation: () => T,
    canRetry: () => boolean = () => true,
): T {
    for (let attempt = 1; ; attempt += 1) {
        try {
            return operation();
        } catch (error) {
            if (
                !isSqliteBusyError(error) ||
                !canRetry() ||
                attempt >= SQLITE_BUSY_RETRY_POLICY.maxAttempts
            ) {
                throw error;
            }
            waitForSqliteBusyRetry(getSqliteBusyRetryDelayMs(attempt));
        }
    }
}

function executeAutocommitWithSqliteBusyRetry<T>(
    conn: BetterSqlite3Database,
    operation: () => T,
): T {
    if (conn.inTransaction) {
        return operation();
    }
    // Do not retry an operation that unexpectedly left a transaction open.
    return executeWithSqliteBusyRetry(operation, () => !conn.inTransaction);
}

function decorateStatementRun(
    conn: BetterSqlite3Database,
    statement: Database.Statement<any>,
): Database.Statement<any> {
    const run = statement.run.bind(statement) as (
        ...params: unknown[]
    ) => Database.RunResult;
    Object.defineProperty(statement, "run", {
        value: (...params: unknown[]) =>
            executeAutocommitWithSqliteBusyRetry(conn, () => run(...params)),
    });
    return statement;
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
        const conn = new Database(currentPath, {
            timeout: SQLITE_BUSY_TIMEOUT_MS,
        });
        try {
            executeWithSqliteBusyRetry(() => applyPragmas(conn));
            currentDb = conn;
        } catch (error) {
            try {
                conn.close();
            } catch {}
            throw error;
        }
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
    const conn = ensureConnection();
    // Preparing can contend briefly with a schema migration in another process.
    const statement = executeAutocommitWithSqliteBusyRetry(conn, () =>
        conn.prepare(sql),
    );
    return decorateStatementRun(conn, statement);
}

export const db = {
    exec(sql: string): void {
        ensureConnection().exec(sql);
    },
    // Use `prepare` for any SQL statement; it returns typed statements
    // for both positional and named parameter styles.
    prepare,
    // Write transactions acquire the writer before reading and retry the whole callback.
    // Callbacks must be synchronous and safe to execute again after rollback.
    writeTransaction<TArgs extends unknown[], TResult>(
        operation: ((...args: TArgs) => TResult) &
            SynchronousTransactionGuard<TResult>,
    ): (...args: TArgs) => TResult {
        const conn = ensureConnection();
        // The driver also rejects Promise results at runtime and rolls back.
        const transaction =
            conn.transaction<(...args: TArgs) => TResult>(operation);
        return (...args: TArgs): TResult => {
            if (conn.inTransaction) {
                return transaction(...args);
            }
            return executeWithSqliteBusyRetry(
                () => transaction.immediate(...args),
                () => !conn.inTransaction,
            );
        };
    },
    get raw(): BetterSqlite3Database {
        return ensureConnection();
    },
};
