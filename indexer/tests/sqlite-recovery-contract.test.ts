import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import runtime from "@artgod/shared/market-data/recovery-runtime" with { type: "json" };
import { resolveProjectPath } from "@artgod/shared/utils/paths";
import { loadSqliteMarketDataMaintenanceConfig } from "../src/config/sqlite-market-data-maintenance.js";

describe("SQLite recovery process contract", () => {
    it("keeps the native deadline and compaction argument aligned with the shared contract", () => {
        const native = readFileSync(
            resolveProjectPath("src-tauri/src/runtime/supervisor.rs"),
            "utf8",
        );
        const task = native.match(
            /const SQLITE_MAINTENANCE_TASK:[\s\S]*?budget: Duration::from_secs\(([^)]+)\)/,
        );
        expect(task).not.toBeNull();
        // Accept only the existing simple integer-product duration expression.
        expect(task![1]).toMatch(/^\d+(?:\s*\*\s*\d+)*$/);
        const seconds = task![1]!
            .split("*")
            .reduce((n, factor) => n * Number(factor.trim()), 1);
        expect(seconds * 1000).toBe(runtime.workBudgetMs);
        expect(
            native.match(/const SQLITE_COMPACTION_ARG: &str = "([^"]+)"/)?.[1],
        ).toBe(runtime.arguments.compactOnly);
    });
    it("loads only the DB input and validated maintenance arguments", () => {
        const env = { ARTGOD_DB_PATH: "tmp/explicit-recovery-fixture/db" };
        expect(loadSqliteMarketDataMaintenanceConfig(env, [])).toEqual({
            databasePath: resolveProjectPath(env.ARTGOD_DB_PATH),
            compact: false,
            compactOnly: false,
        });
        expect(
            loadSqliteMarketDataMaintenanceConfig(env, [
                runtime.arguments.compactOnly,
            ]).compactOnly,
        ).toBe(true);
        expect(() => loadSqliteMarketDataMaintenanceConfig({}, [])).toThrow(
            "ARTGOD_DB_PATH",
        );
        expect(() =>
            loadSqliteMarketDataMaintenanceConfig(env, [
                runtime.arguments.compactOnly,
                runtime.arguments.compact,
            ]),
        ).toThrow("Choose either");
        expect(() =>
            loadSqliteMarketDataMaintenanceConfig(env, ["--unknown"]),
        ).toThrow();
    });
});
