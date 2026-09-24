#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import recoveryRuntime from "../../shared/market-data/recovery-runtime.json" with { type: "json" };

const self = fileURLToPath(import.meta.url);
const root = resolve(dirname(self), "../..");
const fixtureMode = process.argv[2] === "--fixture-writer";
const fixtureRows = 6_000;
const runtime = resolve(
    process.argv[fixtureMode ? 3 : 2] ??
        join(root, "src-tauri/resources/runtime"),
);
const Database = createRequire(join(runtime, "indexer/package.json"))(
    "better-sqlite3",
);

if (fixtureMode) {
    // This deliberately asserts persisted wire values, independently of source
    // imports: the parent runs both this fixture and recovery with staged Node.
    const db = new Database(process.argv[4]);
    db.pragma("journal_mode=WAL");
    db.pragma("wal_autocheckpoint=0");
    db.transaction(() => {
        db.prepare(
            "INSERT INTO collections(collection_id,chain_id,slug,address,standard,status,token_scope_kind) VALUES (99,1,'fixture','0xcollection','erc721','ready','contract_all_tokens')",
        ).run();
        db.prepare(
            "INSERT INTO app_settings(key,value) VALUES ('crash-preservation','unchanged')",
        ).run();
        db.prepare(
            "UPDATE market_data_recovery SET stage='activities',cursor=0,removed_rows=0",
        ).run();
        const insert = db.prepare(
            "INSERT INTO activities(chain_id,collection_id,scope_kind,kind,contract_address,occurred_at,source_kind,source_name,payload_json,dedupe_key) VALUES (1,99,'collection','bid_created','0xcollection',?,'offchain','fixture',?,?)",
        );
        const payload = JSON.stringify({ fixture: "x".repeat(64) });
        for (let i = 0; i < fixtureRows; i++)
            insert.run(Math.floor(Date.now() / 1000), payload, `crash-${i}`);
    })();
    process.stdout.write("fixture-committed\n");
    // The parent kills only this known child, leaving committed WAL to recover.
    setInterval(() => {}, 1000);
} else {
    const base = join(root, "tmp/sqlite-storage-qa");
    mkdirSync(base, { recursive: true });
    const directory = mkdtempSync(join(base, "bundled-crash-"));
    const databasePath = join(directory, "db");
    const node = join(
        runtime,
        "node",
        process.platform === "win32" ? "node.exe" : "node",
    );
    const entry = join(
        runtime,
        "indexer/dist-desktop/sqlite-market-data-maintenance.mjs",
    );
    const env = {
        ...process.env,
        ARTGOD_WORKSPACE_ROOT: runtime,
        ARTGOD_DB_PATH: databasePath,
        TMPDIR: directory,
        SQLITE_TMPDIR: directory,
    };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;

    async function run(args, interruptWhen, expectedCode = 0) {
        return await new Promise((resolveRun, reject) => {
            const child = spawn(node, args, {
                cwd: runtime,
                env,
                stdio: ["ignore", "pipe", "pipe"],
            });
            let output = "";
            let pending = "";
            let interrupted = false;
            const deadline = setTimeout(() => child.kill("SIGKILL"), 90_000);
            const stop = () => child.kill("SIGKILL");
            process.once("SIGINT", stop);
            process.once("SIGTERM", stop);
            const cleanup = () => {
                clearTimeout(deadline);
                process.removeListener("SIGINT", stop);
                process.removeListener("SIGTERM", stop);
            };
            child.stdout.on("data", (chunk) => {
                output += chunk;
                pending += chunk;
                const lines = pending.split("\n");
                pending = lines.pop();
                for (const line of lines) {
                    if (!interrupted && interruptWhen?.(line)) {
                        interrupted = true;
                        child.kill("SIGKILL");
                    }
                }
            });
            child.stderr.on("data", (chunk) => {
                output += chunk;
            });
            child.once("error", (error) => {
                cleanup();
                reject(error);
            });
            child.once("close", (code, signal) => {
                cleanup();
                if (
                    interruptWhen
                        ? interrupted && signal === "SIGKILL"
                        : code === expectedCode
                )
                    resolveRun(output);
                else
                    reject(
                        new Error(
                            `Bundled fixture failed (${code ?? signal}): ${output}`,
                        ),
                    );
            });
        });
    }

    function recoveryLog(output, action) {
        for (const line of output.split("\n")) {
            try {
                const record = JSON.parse(line);
                if (
                    record.component === recoveryRuntime.logComponent &&
                    record.action === action
                )
                    return record;
            } catch {
                // Migration/dotenv output is not part of the recovery log contract.
            }
        }
        assert.fail(`Missing recovery log action ${action}: ${output}`);
    }

    console.log("Initializing a disposable bundled-runtime fixture");
    recoveryLog(await run([entry]), recoveryRuntime.logActions.completed);
    recoveryLog(
        await run([entry, "--invalid-fixture-argument"], undefined, 1),
        recoveryRuntime.logActions.failed,
    );
    console.log("Writing committed WAL without closing its writer");
    await run(
        [self, "--fixture-writer", runtime, databasePath],
        (line) => line === "fixture-committed",
    );
    const walBytes = statSync(`${databasePath}-wal`).size;
    assert.ok(walBytes > 0, "fixture must leave a committed WAL");
    console.log(
        "Interrupting bundled recovery after its first committed batch",
    );
    await run([entry], (line) => {
        try {
            const progress = JSON.parse(line);
            return (
                progress.component === recoveryRuntime.logComponent &&
                progress.action === recoveryRuntime.logActions.progress &&
                progress.stage === "activities" &&
                progress.cursor > 0
            );
        } catch {
            return false;
        }
    });
    const interrupted = new Database(databasePath, {
        readonly: true,
        fileMustExist: true,
    });
    const progress = interrupted
        .prepare("SELECT stage,cursor FROM market_data_recovery")
        .get();
    assert.equal(progress.stage, "activities");
    assert.ok(progress.cursor > 0 && progress.cursor < fixtureRows);
    interrupted.close();
    await run([entry]);
    await run([entry]);
    const compacted = recoveryLog(
        await run([entry, recoveryRuntime.cliArguments.compactOnly]),
        recoveryRuntime.logActions.compacted,
    );
    assert.equal(
        compacted.compaction.compacted,
        false,
        "small fixtures must skip physical shrinking",
    );
    const recovered = new Database(databasePath, {
        readonly: true,
        fileMustExist: true,
    });
    assert.equal(recovered.pragma("quick_check", { simple: true }), "ok");
    assert.equal(
        recovered.prepare("SELECT COUNT(*) AS count FROM activities").get()
            .count,
        0,
    );
    assert.equal(
        recovered
            .prepare(
                "SELECT value FROM app_settings WHERE key='crash-preservation'",
            )
            .get().value,
        "unchanged",
    );
    assert.equal(
        recovered.prepare("SELECT stage FROM market_data_recovery").get().stage,
        "complete",
    );
    recovered.close();
    console.log(
        JSON.stringify({
            walBytes,
            resumedAfterCursor: progress.cursor,
            integrity: "ok",
            retry: "idempotent",
            fixtureDirectory: directory,
        }),
    );
}
