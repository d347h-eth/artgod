import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import runtime from "@artgod/shared/market-data/recovery-runtime" with { type: "json" };
import { resolveProjectPath } from "@artgod/shared/utils/paths";
import { loadSqliteMarketDataMaintenanceConfig } from "../src/config/sqlite-market-data-maintenance.js";

describe("SQLite recovery process contract", () => {
    it("loads the shared JSON contract through the tsx ES module loader", () => {
        // Vitest's JSON handling does not exercise the loader used by source runtimes.
        const child = spawnSync(
            process.execPath,
            [
                "--import",
                "tsx",
                "--input-type=module",
                "--eval",
                `import runtime from "@artgod/shared/market-data/recovery-runtime" with { type: "json" };
                 process.stdout.write(JSON.stringify(runtime));`,
            ],
            {
                cwd: resolveProjectPath("indexer"),
                encoding: "utf8",
                timeout: 5_000,
            },
        );
        expect(child.error).toBeUndefined();
        expect(child.status, child.stderr).toBe(0);
        expect(JSON.parse(child.stdout)).toEqual(runtime);
    });

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
        ).toBe(runtime.cliArguments.compactOnly);
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
                runtime.cliArguments.compactOnly,
            ]).compactOnly,
        ).toBe(true);
        expect(() => loadSqliteMarketDataMaintenanceConfig({}, [])).toThrow(
            "ARTGOD_DB_PATH",
        );
        expect(() =>
            loadSqliteMarketDataMaintenanceConfig(env, [
                runtime.cliArguments.compactOnly,
                runtime.cliArguments.compact,
            ]),
        ).toThrow("Choose either");
        expect(() =>
            loadSqliteMarketDataMaintenanceConfig(env, ["--unknown"]),
        ).toThrow();
    });
});
