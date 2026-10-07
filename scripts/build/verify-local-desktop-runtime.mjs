#!/usr/bin/env node
import path from "node:path";
import {
    localDesktopPaths,
    LOCAL_RUNTIME_RELATIVE_PATH,
} from "./local-desktop-contract.mjs";
import { verifyTauriNoBundleRuntime } from "./verify-tauri-no-bundle-runtime.mjs";
import { verifyStagedDesktopRuntimeDependencies } from "./verify-staged-desktop-runtime-dependencies.mjs";
import { verifyLocalDesktopObservabilityDependencies } from "./verify-local-desktop-observability.mjs";
import {
    WALLET_RECIPIENT_INTEGRITY_SNAPSHOT_FILE_NAME,
    readWalletRecipientIntegritySnapshot,
    verifyWalletRecipientIntegritySnapshot,
} from "./wallet-recipient-integrity-snapshot.mjs";

const paths = localDesktopPaths();
const args = process.argv.slice(2);
const debug = args[0] === "--debug";
if (debug) args.shift();
if (args.length > 2 || args.some((arg) => arg.startsWith("--")))
    throw new Error(
        "Usage: verify-local-desktop-runtime.mjs [--debug] [profile-output] [extracted-runtime]",
    );
const profileOutput = args[0]
    ? path.resolve(args[0])
    : path.join(paths.cargo, debug ? "debug" : "release");
if (debug && path.basename(profileOutput) !== "debug")
    throw new Error("--debug requires a Cargo debug output directory.");
// Cargo debug builds intentionally omit release wallet-recipient hashes.
// Keep release verification mandatory unless debug is selected explicitly.
const snapshot = debug
    ? null
    : await readWalletRecipientIntegritySnapshot(
          path.join(
              profileOutput,
              WALLET_RECIPIENT_INTEGRITY_SNAPSHOT_FILE_NAME,
          ),
      );
const roots = [path.join(profileOutput, LOCAL_RUNTIME_RELATIVE_PATH)];
if (args[1]) roots.push(path.resolve(args[1]));
if (snapshot)
    await verifyWalletRecipientIntegritySnapshot(snapshot, paths.resources);
for (const runtimeRoot of roots) {
    await verifyTauriNoBundleRuntime({
        stagedRuntimeRoot: paths.resources,
        noBundleRuntimeRoot: runtimeRoot,
    });
    if (snapshot)
        await verifyWalletRecipientIntegritySnapshot(snapshot, runtimeRoot);
    const nodeBinaryPath = path.join(
        runtimeRoot,
        "node",
        process.platform === "win32" ? "node.exe" : "node",
    );
    await verifyStagedDesktopRuntimeDependencies({
        resourcesRootDir: runtimeRoot,
        nodeBinaryPath,
    });
    await verifyLocalDesktopObservabilityDependencies({
        resourcesRootDir: runtimeRoot,
        nodeBinaryPath,
    });
    console.log(
        `Verified local desktop runtime bytes${snapshot ? ", integrity" : ""} and native imports: ${runtimeRoot}`,
    );
}
