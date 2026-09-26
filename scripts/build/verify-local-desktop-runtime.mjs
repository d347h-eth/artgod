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
const profileOutput = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(paths.cargo, "release");
const snapshot = await readWalletRecipientIntegritySnapshot(
    path.join(profileOutput, WALLET_RECIPIENT_INTEGRITY_SNAPSHOT_FILE_NAME),
);
const roots = [path.join(profileOutput, LOCAL_RUNTIME_RELATIVE_PATH)];
if (process.argv[3]) roots.push(path.resolve(process.argv[3]));
await verifyWalletRecipientIntegritySnapshot(snapshot, paths.resources);
for (const runtimeRoot of roots) {
    await verifyTauriNoBundleRuntime({
        stagedRuntimeRoot: paths.resources,
        noBundleRuntimeRoot: runtimeRoot,
    });
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
        `Verified local desktop runtime bytes, integrity and native imports: ${runtimeRoot}`,
    );
}
