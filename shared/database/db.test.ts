import Database from "better-sqlite3";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, setDbPath, SQLITE_BUSY_RETRY_POLICY } from "./db.js";

const SQLITE_BUSY_ERROR_CODE = "SQLITE_BUSY";
const SQLITE_BUSY_SNAPSHOT_ERROR_CODE = "SQLITE_BUSY_SNAPSHOT";
const SQLITE_LOCKED_ERROR_CODE = "SQLITE_LOCKED";
const SQLITE_LOCK_ERROR_MESSAGE = "database is locked";
const SQLITE_TABLE_LOCK_ERROR_MESSAGE = "database table is locked";
const LOCK_ACQUIRED_MESSAGE = "lock-acquired";
const RELEASE_LOCK_MESSAGE = "release-lock";
const LOCK_RELEASE_SCHEDULED_MESSAGE = "lock-release-scheduled";
const UNEXPECTED_WRITER_LOCK_MESSAGE_ERROR =
    "Unexpected writer-lock control message";
const TEST_BUSY_TIMEOUT_MS = 0;
const WORKER_LOCK_HOLD_MS = 20;

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

    it("retries one autocommit statement after another writer releases", async () => {
        db.raw.pragma(`busy_timeout = ${TEST_BUSY_TIMEOUT_MS}`);
        const worker = startWriterLockWorker(dbPath);
        const exitPromise = once(worker, "exit");
        await waitForWriterLock(worker);
        await scheduleWriterLockRelease(worker);

        const result = db
            .prepare<
                [number]
            >("UPDATE counters SET value = value + 1 WHERE id = ?")
            .run(1);

        const [exitCode] = await exitPromise;
        expect(exitCode).toBe(0);
        expect(result.changes).toBe(1);
        expect(readCounterValue()).toBe(1);
    });

    it("retries a write transaction after another writer releases", async () => {
        db.raw.pragma(`busy_timeout = ${TEST_BUSY_TIMEOUT_MS}`);
        const worker = startWriterLockWorker(dbPath);
        const exitPromise = once(worker, "exit");
        await waitForWriterLock(worker);
        await scheduleWriterLockRelease(worker);
        const write = db.writeTransaction(() => {
            db.prepare<[number]>(
                "UPDATE counters SET value = value + 1 WHERE id = ?",
            ).run(1);
        });

        write();

        const [exitCode] = await exitPromise;
        expect(exitCode).toBe(0);
        expect(readCounterValue()).toBe(1);
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

async function waitForWriterLock(worker: Worker): Promise<void> {
    const [message] = await once(worker, "message");
    expect(message).toBe(LOCK_ACQUIRED_MESSAGE);
}

async function scheduleWriterLockRelease(worker: Worker): Promise<void> {
    const releaseScheduled = once(worker, "message");
    worker.postMessage(RELEASE_LOCK_MESSAGE);
    const [message] = await releaseScheduled;
    expect(message).toBe(LOCK_RELEASE_SCHEDULED_MESSAGE);
}

function startWriterLockWorker(dbPath: string): Worker {
    const betterSqlite3Path = createRequire(import.meta.url).resolve(
        "better-sqlite3",
    );
    return new Worker(
        `
            const { parentPort, workerData } = require("node:worker_threads");
            const Database = require(workerData.betterSqlite3Path);
            const database = new Database(workerData.dbPath, {
                timeout: workerData.busyTimeoutMs,
            });
            database.pragma("journal_mode = WAL");
            database.exec("BEGIN IMMEDIATE");
            parentPort.postMessage(workerData.lockAcquiredMessage);
            parentPort.once("message", (message) => {
                if (message !== workerData.releaseLockMessage) {
                    throw new Error(workerData.unexpectedControlMessageError);
                }
                setTimeout(() => {
                    database.exec("COMMIT");
                    database.close();
                }, workerData.lockHoldMs);
                parentPort.postMessage(workerData.lockReleaseScheduledMessage);
            });
        `,
        {
            eval: true,
            workerData: {
                betterSqlite3Path,
                busyTimeoutMs: TEST_BUSY_TIMEOUT_MS,
                dbPath,
                lockAcquiredMessage: LOCK_ACQUIRED_MESSAGE,
                lockReleaseScheduledMessage: LOCK_RELEASE_SCHEDULED_MESSAGE,
                lockHoldMs: WORKER_LOCK_HOLD_MS,
                releaseLockMessage: RELEASE_LOCK_MESSAGE,
                unexpectedControlMessageError:
                    UNEXPECTED_WRITER_LOCK_MESSAGE_ERROR,
            },
        },
    );
}
