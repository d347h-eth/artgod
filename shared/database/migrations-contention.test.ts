import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, setDbPath } from "./db.js";
import { MigrationRunner } from "./migrations.js";

// This fixture makes duplicate application and partial schema changes observable.
const TRANSACTION_FIXTURE_MIGRATION = "001_transaction_fixture.sql";
const TRANSACTION_FIXTURE_SQL =
    "CREATE TABLE migration_counter (id INTEGER PRIMARY KEY);" +
    "INSERT INTO migration_counter (id) VALUES (1);";

describe("MigrationRunner contention and atomicity", () => {
    let tempDir: string;
    let migrationsDir: string;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), "artgod-migration-contention-"));
        migrationsDir = join(tempDir, "migrations");
        mkdirSync(migrationsDir);
        writeFileSync(
            join(migrationsDir, TRANSACTION_FIXTURE_MIGRATION),
            TRANSACTION_FIXTURE_SQL,
        );
        setDbPath(join(tempDir, "test.sqlite"));
    });

    afterEach(() => {
        setDbPath(join(tmpdir(), "artgod-migration-contention-closed.sqlite"));
        rmSync(tempDir, { recursive: true, force: true });
    });

    it("skips applied migrations while another connection owns the writer", async () => {
        const runner = new MigrationRunner(migrationsDir);
        await runner.runMigrations();
        db.raw.pragma("busy_timeout = 0");
        const competitor = new Database(db.raw.name);
        competitor.exec("BEGIN IMMEDIATE");

        try {
            await runner.runMigrations();
            expect(competitor.inTransaction).toBe(true);
            expect(
                db.prepare<[]>("SELECT id FROM migration_counter").all(),
            ).toEqual([{ id: 1 }]);
            expect(db.prepare<[]>("SELECT name FROM migrations").all()).toEqual(
                [{ name: TRANSACTION_FIXTURE_MIGRATION }],
            );
        } finally {
            competitor.close();
        }
    });

    it("rolls back failed migration SQL and its ledger before a later retry", async () => {
        writeFileSync(
            join(migrationsDir, TRANSACTION_FIXTURE_MIGRATION),
            TRANSACTION_FIXTURE_SQL +
                "INSERT INTO migration_counter (id) VALUES (1);",
        );
        const runner = new MigrationRunner(migrationsDir);

        await expect(runner.runMigrations()).rejects.toThrow(
            Database.SqliteError,
        );
        expect(db.raw.inTransaction).toBe(false);
        expect(db.prepare<[]>("SELECT name FROM migrations").all()).toEqual([]);
        expect(
            db
                .prepare<
                    []
                >("SELECT name FROM sqlite_master WHERE name = 'migration_counter'")
                .get(),
        ).toBeUndefined();

        writeFileSync(
            join(migrationsDir, TRANSACTION_FIXTURE_MIGRATION),
            TRANSACTION_FIXTURE_SQL,
        );
        await runner.runMigrations();
        expect(
            db.prepare<[]>("SELECT id FROM migration_counter").all(),
        ).toEqual([{ id: 1 }]);
        expect(db.prepare<[]>("SELECT name FROM migrations").all()).toEqual([
            { name: TRANSACTION_FIXTURE_MIGRATION },
        ]);
    });
});
