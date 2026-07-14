#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
);
const tauriManifestPath = path.join(rootDir, "src-tauri", "Cargo.toml");

// Exact native tests that own the installed desktop listener contract.
const DESKTOP_LISTENER_BOUNDARY_TESTS = Object.freeze([
    "runtime::config::tests::desktop_listener_configuration_requires_numeric_ipv4_loopback",
    "runtime::supervisor::tests::nats_launch_binds_numeric_ipv4_loopback_and_uses_configured_store_root",
]);

// Avoid requiring already-built external sidecars for source-only listener tests.
const testTauriConfig = JSON.stringify({ bundle: { externalBin: [] } });

for (const testName of DESKTOP_LISTENER_BOUNDARY_TESTS) {
    await runExactCargoTest(testName);
}

console.log("Verified native desktop listener boundaries.");

async function runExactCargoTest(testName) {
    await new Promise((resolve, reject) => {
        const child = spawn(
            "cargo",
            [
                "test",
                "--manifest-path",
                tauriManifestPath,
                "--locked",
                testName,
                "--lib",
                "--",
                "--exact",
            ],
            {
                cwd: rootDir,
                env: {
                    ...process.env,
                    TAURI_CONFIG: testTauriConfig,
                },
                stdio: "inherit",
            },
        );
        child.once("error", (error) => {
            reject(
                new Error(
                    `Unable to start desktop listener boundary test ${testName}: ${String(error)}`,
                ),
            );
        });
        child.once("exit", (code, signal) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(
                new Error(
                    `Desktop listener boundary test ${testName} failed with code ${String(code)} and signal ${String(signal)}.`,
                ),
            );
        });
    });
}
