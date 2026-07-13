#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
);
const tauriConfigEnvironmentKey = "TAURI_CONFIG";
const adminManifestTestTarget =
    "runtime::app_config_manifest::tests::observability_settings_are_not_admin_managed";

// The focused unit test does not package an app, so omit release sidecars from Tauri's merged config.
const tauriConfigOverride = JSON.stringify({
    bundle: {
        externalBin: [],
    },
});
const result = spawnSync(
    "cargo",
    [
        "test",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "--locked",
        adminManifestTestTarget,
        "--lib",
        "--",
        "--exact",
    ],
    {
        cwd: rootDir,
        env: {
            ...process.env,
            [tauriConfigEnvironmentKey]: tauriConfigOverride,
        },
        shell: false,
        stdio: "inherit",
    },
);

if (result.error) {
    console.error(
        `Failed to execute the desktop Admin manifest test: ${result.error}`,
    );
    process.exit(1);
}
if (result.status !== 0) {
    process.exit(result.status ?? 1);
}
