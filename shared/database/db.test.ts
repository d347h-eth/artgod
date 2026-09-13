import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath, SQLITE_BUSY_RETRY_POLICY } from "./db.js";

// Assert the native SQLite error vocabulary at the driver boundary.
const SQLITE_BUSY_ERROR_CODE = "SQLITE_BUSY";
const SQLITE_BUSY_SNAPSHOT_ERROR_CODE = "SQLITE_BUSY_SNAPSHOT";
const SQLITE_LOCKED_ERROR_CODE = "SQLITE_LOCKED";
const SQLITE_LOCK_ERROR_MESSAGE = "database is locked";
const SQLITE_TABLE_LOCK_ERROR_MESSAGE = "database table is locked";
const TEST_BUSY_TIMEOUT_MS = 0;

describe("shared SQLite contention policy", () => {
    let tempDir: string;
    let dbPath: string;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), "artgod-sqlite-contention-"));
        dbPath = join(tempDir, "test.sqlite");
        setDbPath(dbPath);
        db.exec(
            "CREATE TABLE counters (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)",
        );
        db.prepare<[number, number]>(
            "INSERT INTO counters (id, value) VALUES (?, ?)",
        ).run(1, 0);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        setDbPath(join(tmpdir(), "artgod-sqlite-contention-closed.sqlite"));
        rmSync(tempDir, { recursive: true, force: true });
    });

    it("retries and rolls back the complete write transaction on a busy snapshot", () => {
        let attempts = 0;
        const write = db.writeTransaction(() => {
            attempts += 1;
            db.prepare<[number]>(
                "UPDATE counters SET value = value + 1 WHERE id = ?",
            ).run(1);
            if (attempts === 1) {
                throw new Database.SqliteError(
                    SQLITE_LOCK_ERROR_MESSAGE,
                    SQLITE_BUSY_SNAPSHOT_ERROR_CODE,
                );
            }
        });

        write();

        expect(attempts).toBe(2);
        expect(readCounterValue()).toBe(1);
    });

    it("stops after the bounded busy retry budget and preserves rollback", () => {
        let attempts = 0;
        const busyError = new Database.SqliteError(
            SQLITE_LOCK_ERROR_MESSAGE,
            SQLITE_BUSY_ERROR_CODE,
        );
        const write = db.writeTransaction(() => {
            attempts += 1;
            db.prepare<[number]>(
                "UPDATE counters SET value = value + 1 WHERE id = ?",
            ).run(1);
            throw busyError;
        });

        expect(() => write()).toThrow(busyError);
        expect(attempts).toBe(SQLITE_BUSY_RETRY_POLICY.maxAttempts);
        expect(readCounterValue()).toBe(0);
    });

    it("does not retry non-busy SQLite failures", () => {
        let attempts = 0;
        const lockedError = new Database.SqliteError(
            SQLITE_TABLE_LOCK_ERROR_MESSAGE,
            SQLITE_LOCKED_ERROR_CODE,
        );
        const write = db.writeTransaction(() => {
            attempts += 1;
            throw lockedError;
        });

        expect(() => write()).toThrow(lockedError);
        expect(attempts).toBe(1);
    });

    it("rejects Promise-returning callbacks and rolls back their writes", () => {
        const write = db.writeTransaction(
            // @ts-expect-error Transaction callbacks must finish before SQLite commits.
            () => {
                db.prepare<[number]>(
                    "UPDATE counters SET value = value + 1 WHERE id = ?",
                ).run(1);
                return Promise.resolve();
            },
        );

        expect(() => write()).toThrowError();
        expect(readCounterValue()).toBe(0);
    });

    it("retries the outer transaction when a nested savepoint reports busy", () => {
        let outerAttempts = 0;
        let nestedAttempts = 0;
        const busyError = new Database.SqliteError(
            SQLITE_LOCK_ERROR_MESSAGE,
            SQLITE_BUSY_ERROR_CODE,
        );
        const nestedWrite = db.writeTransaction(() => {
            nestedAttempts += 1;
            db.prepare<[number]>(
                "UPDATE counters SET value = value + 1 WHERE id = ?",
            ).run(1);
            if (outerAttempts === 1) {
                throw busyError;
            }
        });
        const outerWrite = db.writeTransaction(() => {
            outerAttempts += 1;
            db.prepare<[number]>(
                "UPDATE counters SET value = value + 10 WHERE id = ?",
            ).run(1);
            nestedWrite();
        });

        outerWrite();

        expect(outerAttempts).toBe(2);
        expect(nestedAttempts).toBe(2);
        expect(readCounterValue()).toBe(11);
    });

    it("acquires the writer before a transaction callback can read", () => {
        const competitor = new Database(dbPath, {
            timeout: TEST_BUSY_TIMEOUT_MS,
        });
        competitor.pragma("journal_mode = WAL");
        let competitorErrorCode: string | undefined;
        const write = db.writeTransaction(() => {
            db.prepare<[number]>("SELECT value FROM counters WHERE id = ?").get(
                1,
            );
            try {
                competitor
                    .prepare(
                        "UPDATE counters SET value = value + 1 WHERE id = ?",
                    )
                    .run(1);
            } catch (error) {
                competitorErrorCode = readErrorCode(error);
            }
            db.prepare<[number]>(
                "UPDATE counters SET value = value + 1 WHERE id = ?",
            ).run(1);
        });

        try {
            write();
        } finally {
            competitor.close();
        }

        expect(competitorErrorCode).toBe(SQLITE_BUSY_ERROR_CODE);
        expect(readCounterValue()).toBe(1);
    });

    it("retries one autocommit statement after another writer releases", () => {
        db.raw.pragma(`busy_timeout = ${TEST_BUSY_TIMEOUT_MS}`);
        const competitor = new Database(dbPath);
        competitor.exec("BEGIN IMMEDIATE");
        // Release only after a real SQLITE_BUSY reaches the application backoff.
        const backoff = vi.spyOn(Atomics, "wait").mockImplementationOnce(() => {
            expect(readCounterValue()).toBe(0);
            competitor.exec("COMMIT");
            return "ok";
        });

        try {
            const result = db
                .prepare<{
                    id: number;
                }>("UPDATE counters SET value = value + 1 WHERE id = @id")
                .run({ id: 1 });

            expect(backoff).toHaveBeenCalledTimes(1);
            expect(result.changes).toBe(1);
            expect(readCounterValue()).toBe(1);
        } finally {
            competitor.close();
        }
    });

    it("retries a write transaction after another writer releases", () => {
        db.raw.pragma(`busy_timeout = ${TEST_BUSY_TIMEOUT_MS}`);
        const competitor = new Database(dbPath);
        competitor.exec("BEGIN IMMEDIATE");
        const callback = vi.fn(() => {
            db.prepare<[number]>(
                "UPDATE counters SET value = value + 1 WHERE id = ?",
            ).run(1);
            return readCounterValue();
        });
        const write = db.writeTransaction(callback);
        const backoff = vi.spyOn(Atomics, "wait").mockImplementationOnce(() => {
            expect(callback).not.toHaveBeenCalled();
            competitor.exec("COMMIT");
            return "ok";
        });

        try {
            expect(write()).toBe(1);
            expect(backoff).toHaveBeenCalledTimes(1);
            expect(callback).toHaveBeenCalledTimes(1);
            expect(readCounterValue()).toBe(1);
        } finally {
            competitor.close();
        }
    });

    it("exhausts real autocommit contention without changing data", () => {
        db.raw.pragma(`busy_timeout = ${TEST_BUSY_TIMEOUT_MS}`);
        const statement = db.prepare<[number]>(
            "UPDATE counters SET value = value + 1 WHERE id = ?",
        );
        const competitor = new Database(dbPath);
        competitor.exec("BEGIN IMMEDIATE");
        const backoff = vi.spyOn(Atomics, "wait");

        try {
            expect(() => statement.run(1)).toThrow(
                expect.objectContaining({ code: SQLITE_BUSY_ERROR_CODE }),
            );
            expect(backoff).toHaveBeenCalledTimes(
                SQLITE_BUSY_RETRY_POLICY.maxAttempts - 1,
            );
            expect(db.raw.inTransaction).toBe(false);
            expect(readCounterValue()).toBe(0);
        } finally {
            competitor.close();
        }

        // Exhaustion must leave the connection and statement usable.
        expect(statement.run(1).changes).toBe(1);
        expect(readCounterValue()).toBe(1);
    });

    it("leaves snapshot failure inside a raw transaction to its owner", () => {
        const competitor = new Database(dbPath);
        const backoff = vi.spyOn(Atomics, "wait");
        const write = db.raw.transaction(() => {
            expect(readCounterValue()).toBe(0);
            competitor
                .prepare("UPDATE counters SET value = value + 10 WHERE id = 1")
                .run();
            db.prepare<[number]>(
                "UPDATE counters SET value = value + 1 WHERE id = ?",
            ).run(1);
        });

        try {
            expect(write).toThrow(
                expect.objectContaining({
                    code: SQLITE_BUSY_SNAPSHOT_ERROR_CODE,
                }),
            );
            expect(backoff).not.toHaveBeenCalled();
            expect(db.raw.inTransaction).toBe(false);
            expect(readCounterValue()).toBe(10);
        } finally {
            competitor.close();
        }
    });

    it("does not retry an autocommit constraint violation", () => {
        const backoff = vi.spyOn(Atomics, "wait");
        expect(() =>
            db
                .prepare<
                    [number, number]
                >("INSERT INTO counters (id, value) VALUES (?, ?)")
                .run(1, 1),
        ).toThrow(Database.SqliteError);
        expect(backoff).not.toHaveBeenCalled();
        expect(readCounterValue()).toBe(0);
    });

    function readCounterValue(): number {
        const row = db
            .prepare<[number]>("SELECT value FROM counters WHERE id = ?")
            .get(1) as { value: number };
        return row.value;
    }
});

function readErrorCode(error: unknown): string | undefined {
    if (typeof error !== "object" || error === null || !("code" in error)) {
        return undefined;
    }
    const code = Reflect.get(error, "code");
    return typeof code === "string" ? code : undefined;
}
