#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compareRuntimeTrees } from "./verify-linux-bundled-runtime.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(scriptPath), "../..");

// Proves the one real no-bundle build copied the complete current staged runtime.
export async function verifyTauriNoBundleRuntime({
    stagedRuntimeRoot,
    noBundleRuntimeRoot,
}) {
    await compareRuntimeTrees(stagedRuntimeRoot, noBundleRuntimeRoot);
}

async function main() {
    const noBundleRuntimeRoot = process.argv[2]
        ? path.resolve(process.argv[2])
        : path.join(
              rootDir,
              "src-tauri",
              "target",
              "debug",
              "resources",
              "runtime",
          );
    await verifyTauriNoBundleRuntime({
        stagedRuntimeRoot: path.join(
            rootDir,
            "src-tauri",
            "resources",
            "runtime",
        ),
        noBundleRuntimeRoot,
    });
    console.log(
        `Verified no-bundle runtime output at ${path.relative(rootDir, noBundleRuntimeRoot)}.`,
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    await main();
}
