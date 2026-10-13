import { verifySecretPromptStartup } from "./verify-bundled-secret-prompt.mjs";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveTauriCargoTargetDirectory } from "./build-tauri.mjs";
import { DESKTOP_RUST_TARGET } from "./native-runtime-dependencies.mjs";
import { compareRuntimeTrees } from "./verify-linux-bundled-runtime.mjs";
import { verifyStagedDesktopRuntimeDependencies } from "./verify-staged-desktop-runtime-dependencies.mjs";
import { verifyStagedDesktopNatsLoopbackBinding } from "./verify-staged-desktop-nats-loopback.mjs";
import {
    readWalletRecipientIntegritySnapshot,
    verifyWalletRecipientIntegritySnapshot,
    WALLET_RECIPIENT_INTEGRITY_SNAPSHOT_FILE_NAME,
} from "./wallet-recipient-integrity-snapshot.mjs";
import { runRedactedCommand } from "./secret-output-redaction.mjs";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
export const WINDOWS_ARTIFACT_DIRECTORY = "windows-artifact";

// The pinned Tauri 2.11.3 bundler patches only the first bundle-type marker for
// NSIS, then restores Cargo's original executable. Hash that exact wire change;
// every other byte remains protected, without buffering the whole PE file.
// See crates/tauri-bundler/src/bundle.rs at upstream tag tauri-cli-v2.11.3.
const tauriUnknownBundleMarker = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_UNK");
const tauriNsisBundleMarker = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_NSS");
export async function hashExpectedNsisShell(chunks) {
    const hash = createHash("sha256");
    let pending = Buffer.alloc(0);
    let found = false;
    for await (const chunk of chunks) {
        if (found) {
            hash.update(chunk);
            continue;
        }
        const bytes = Buffer.concat([pending, chunk]);
        const markerOffset = bytes.indexOf(tauriUnknownBundleMarker);
        if (markerOffset !== -1) {
            hash.update(bytes.subarray(0, markerOffset));
            hash.update(tauriNsisBundleMarker);
            hash.update(
                bytes.subarray(markerOffset + tauriUnknownBundleMarker.length),
            );
            pending = Buffer.alloc(0);
            found = true;
        } else {
            const safeLength = Math.max(
                0,
                bytes.length - tauriUnknownBundleMarker.length + 1,
            );
            hash.update(bytes.subarray(0, safeLength));
            pending = bytes.subarray(safeLength);
        }
    }
    if (!found)
        throw new Error(
            "Cargo shell lacks the reviewed Tauri bundle-type marker.",
        );
    return hash.digest("hex");
}

// Silent installation exercises the actual NSIS payload without driving host GUI.
// Native import/loopback probes use the same owners as Linux/macOS packaging.
export async function verifyWindowsBundledRuntime({
    projectRoot = rootDir,
    runCommand = runRedactedCommand,
    environment = process.env,
} = {}) {
    if (process.platform !== "win32")
        throw new Error("Windows installer verification requires Windows.");
    const targetRoot = await resolveTauriCargoTargetDirectory({
        projectRoot,
        runCommand,
        environment,
    });
    const releaseRoot = path.join(
        targetRoot,
        DESKTOP_RUST_TARGET.WindowsX64,
        "release",
    );
    const bundleRoot = path.join(releaseRoot, "bundle", "nsis");
    const installers = (await readdir(bundleRoot)).filter((name) =>
        name.endsWith(".exe"),
    );
    if (installers.length !== 1)
        throw new Error("Expected exactly one Windows NSIS installer.");
    const installerPath = path.join(bundleRoot, installers[0]);
    const tmpRoot = path.join(projectRoot, "tmp");
    await mkdir(tmpRoot, { recursive: true });
    const proofRoot = await mkdtemp(path.join(tmpRoot, "windows-install-"));
    const installRoot = path.join(proofRoot, "ArtGod");
    await runCommand(installerPath, ["/S", `/D=${installRoot}`], {
        cwd: projectRoot,
        env: environment,
        timeoutMs: 120_000,
        stream: true,
    });
    const stagedRoot = path.join(
        projectRoot,
        "src-tauri",
        "resources",
        "runtime",
    );
    const installedRoot = path.join(installRoot, "resources", "runtime");
    const snapshot = await readWalletRecipientIntegritySnapshot(
        path.join(releaseRoot, WALLET_RECIPIENT_INTEGRITY_SNAPSHOT_FILE_NAME),
    );
    await verifyWalletRecipientIntegritySnapshot(snapshot, stagedRoot);
    await compareRuntimeTrees(stagedRoot, installedRoot);
    await verifyWalletRecipientIntegritySnapshot(snapshot, installedRoot);
    await verifyStagedDesktopRuntimeDependencies({
        resourcesRootDir: installedRoot,
        nodeBinaryPath: path.join(installedRoot, "node", "node.exe"),
        environment,
    });
    await verifyStagedDesktopNatsLoopbackBinding({
        natsBinaryPath: path.join(installedRoot, "nats", "nats-server.exe"),
        temporaryDirectory: tmpRoot,
        environment,
    });
    // Bind the installed shell and prompt to the build outputs as well as its runtime.
    const executableNames = ["artgod-desktop.exe", "artgod-secret-prompt.exe"];
    for (const name of executableNames) {
        const builtPath =
            name === executableNames[0]
                ? path.join(releaseRoot, name)
                : path.join(
                      projectRoot,
                      "src-tauri",
                      "binaries",
                      `artgod-secret-prompt-${DESKTOP_RUST_TARGET.WindowsX64}.exe`,
                  );
        const expectedHash =
            name === executableNames[0]
                ? await hashExpectedNsisShell(createReadStream(builtPath))
                : await hashFile(builtPath);
        if (expectedHash !== (await hashFile(path.join(installRoot, name))))
            throw new Error(
                `Installed executable differs from build output: ${name}`,
            );
    }
    await verifySecretPromptStartup(path.join(installRoot, executableNames[1]));
    const pkg = JSON.parse(
        await readFile(path.join(projectRoot, "package.json"), "utf8"),
    );
    const commit = (
        await runCommand("git", ["rev-parse", "HEAD"], { cwd: projectRoot })
    ).stdout.trim();
    const artifactRoot = path.join(tmpRoot, WINDOWS_ARTIFACT_DIRECTORY);
    await mkdir(artifactRoot, { recursive: true });
    await copyFile(installerPath, path.join(artifactRoot, installers[0]));
    await writeFile(
        path.join(artifactRoot, "SHA256SUMS.txt"),
        `${await hashFile(installerPath)}  ${installers[0]}\n`,
    );
    await writeFile(
        path.join(artifactRoot, "build-info.json"),
        JSON.stringify(
            {
                version: pkg.version,
                commit,
                target: DESKTOP_RUST_TARGET.WindowsX64,
                signed: false,
                webview2: "OS-managed prerequisite",
                verified: [
                    "silent installation",
                    "complete runtime bytes",
                    "wallet recipient integrity",
                    "SQLite and Sharp imports",
                    "NATS loopback",
                    "shell and prompt bytes",
                    "prompt exits silently on closed owner input",
                ],
            },
            null,
            4,
        ) + "\n",
    );
    await copyFile(
        path.join(
            projectRoot,
            "docs",
            "desktop",
            "09-windows-build-and-test.md",
        ),
        path.join(artifactRoot, "WINDOWS-TEST.md"),
    );
    console.log(`Verified Windows installer; test artifact: ${artifactRoot}`);
}

async function hashFile(filePath) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    return hash.digest("hex");
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
    await verifyWindowsBundledRuntime();
