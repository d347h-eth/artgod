import {
    copyFile,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    rename,
    rm,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    assertPinnedInputAge,
    assertPinnedInputBytesContract,
    materializePinnedInput,
    verifyGithubReleaseInputProvenance,
} from "./pinned-build-inputs.mjs";
import {
    buildLockedTauri,
    resolveTauriCargoTargetDirectory,
    TAURI_CLI_PACKAGE_NAME,
} from "./build-tauri.mjs";
import { DESKTOP_RUST_TARGET } from "./native-runtime-dependencies.mjs";
import { runRedactedCommand } from "./secret-output-redaction.mjs";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const manifestPath = path.join(
    rootDir,
    "config",
    "tauri-windows-bundler-tools.json",
);
export const WINDOWS_NSIS_ARCHIVE = "nsis-3.11.zip";
export const WINDOWS_NSIS_PLUGIN = "nsis_tauri_utils.dll";
export const WINDOWS_NSIS_DIRECTORY = "NSIS";
// Matches the pinned CLI's required-file check, preventing automatic replacement downloads.
export const WINDOWS_NSIS_REQUIRED_FILES = Object.freeze([
    "makensis.exe",
    "Bin/makensis.exe",
    "Stubs/lzma-x86-unicode",
    "Stubs/lzma_solid-x86-unicode",
    "Plugins/x86-unicode/additional/nsis_tauri_utils.dll",
    "Include/MUI2.nsh",
    "Include/FileFunc.nsh",
    "Include/x64.nsh",
    "Include/nsDialogs.nsh",
    "Include/WinMessages.nsh",
    "Include/Win/COM.nsh",
    "Include/Win/Propkey.nsh",
    "Include/Win/RestartManager.nsh",
]);
// Windows 11 test installers consume the OS-managed WebView2 and acquire no runtime.
export const WINDOWS_BUNDLE_CONFIG = Object.freeze({
    bundle: {
        useLocalToolsDir: true,
        windows: {
            webviewInstallMode: { type: "skip" },
            nsis: { installMode: "currentUser" },
        },
    },
});

export function validateWindowsToolsManifest(
    manifest,
    cliVersion,
    now = new Date(),
) {
    if (
        manifest?.schemaVersion !== 1 ||
        manifest.tauriCliVersion !== cliVersion ||
        manifest.target !== DESKTOP_RUST_TARGET.WindowsX64
    ) {
        throw new Error(
            "Windows packaging manifest must match the pinned CLI and Windows x64 target.",
        );
    }
    const expected = [WINDOWS_NSIS_ARCHIVE, WINDOWS_NSIS_PLUGIN];
    if (
        !Array.isArray(manifest.tools) ||
        manifest.tools.length !== expected.length ||
        expected.some(
            (name) =>
                manifest.tools.filter((tool) => tool.fileName === name)
                    .length !== 1,
        )
    ) {
        throw new Error(
            "Windows packaging manifest must contain exactly the reviewed NSIS archive and plugin.",
        );
    }
    for (const tool of manifest.tools) {
        assertPinnedInputBytesContract(tool);
        assertPinnedInputAge(tool, manifest.minimumAgeDays, now);
        const repository =
            tool.fileName === WINDOWS_NSIS_ARCHIVE
                ? "binary-releases"
                : "nsis-tauri-utils";
        const releaseTag =
            tool.fileName === WINDOWS_NSIS_ARCHIVE
                ? "nsis-3.11"
                : "nsis_tauri_utils-v0.5.3";
        if (
            !new RegExp(
                `^https://api\\.github\\.com/repos/tauri-apps/${repository}/releases/assets/[1-9][0-9]*$`,
            ).test(tool.url) ||
            tool.assetName !== tool.fileName ||
            tool.releaseTag !== releaseTag
        ) {
            throw new Error(
                "Windows packaging input must select the reviewed upstream asset and release.",
            );
        }
    }
    return manifest.tools;
}

// Fresh execution copies prevent an extracted cache from becoming an unverified input.
export async function preparePinnedTauriWindowsBundlerTools({
    projectRoot = rootDir,
    environment = process.env,
    fetchImplementation = fetch,
    runCommand = runRedactedCommand,
    now = new Date(),
} = {}) {
    const manifest = JSON.parse(
        await readFile(
            path.join(projectRoot, "config", path.basename(manifestPath)),
            "utf8",
        ),
    );
    const pkg = JSON.parse(
        await readFile(path.join(projectRoot, "package.json"), "utf8"),
    );
    const tools = validateWindowsToolsManifest(
        manifest,
        pkg.devDependencies[TAURI_CLI_PACKAGE_NAME],
        now,
    );
    const cacheRoot = path.join(
        projectRoot,
        ".cache",
        "desktop-windows-bundler",
    );
    const temporaryRoot = path.join(projectRoot, "tmp");
    await mkdir(cacheRoot, { recursive: true });
    await mkdir(temporaryRoot, { recursive: true });
    const preparationRoot = await mkdtemp(
        path.join(temporaryRoot, "windows-tools-"),
    );
    for (const input of tools) {
        await materializePinnedInput({
            input,
            destinationPath: path.join(cacheRoot, input.fileName),
            temporaryDirectory: preparationRoot,
            verifyProvenance: verifyGithubReleaseInputProvenance,
            fetchImplementation,
            environment,
        });
    }
    const targetRoot = await resolveTauriCargoTargetDirectory({
        projectRoot,
        environment,
        runCommand,
    });
    const toolsRoot = path.join(targetRoot, ".tauri");
    await mkdir(toolsRoot, { recursive: true });
    if (!(await lstat(toolsRoot)).isDirectory())
        throw new Error("Windows local tools root must be a real directory.");
    const literal = (value) => `'${value.replaceAll("'", "''")}'`;
    const extractedRoot = path.join(preparationRoot, "extracted");
    await runCommand(
        "powershell.exe",
        [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath ${literal(path.join(cacheRoot, WINDOWS_NSIS_ARCHIVE))} -DestinationPath ${literal(extractedRoot)}`,
        ],
        { cwd: projectRoot, env: environment },
    );
    const freshNsisRoot = path.join(extractedRoot, "nsis-3.11");
    const pluginDestination = path.join(
        freshNsisRoot,
        WINDOWS_NSIS_REQUIRED_FILES[4],
    );
    await mkdir(path.dirname(pluginDestination), { recursive: true });
    await copyFile(
        path.join(cacheRoot, WINDOWS_NSIS_PLUGIN),
        pluginDestination,
    );
    for (const name of WINDOWS_NSIS_REQUIRED_FILES) {
        if (!(await lstat(path.join(freshNsisRoot, name))).isFile())
            throw new Error(`Pinned NSIS required file missing: ${name}`);
    }
    // Replace only this owner's execution directory, preserving unrelated Tauri tools.
    const nsisRoot = path.join(toolsRoot, WINDOWS_NSIS_DIRECTORY);
    await rm(nsisRoot, { recursive: true, force: true });
    await rename(freshNsisRoot, nsisRoot);
    return { targetRoot, nsisRoot };
}

export async function buildPinnedTauriWindowsBundle(options = {}) {
    if ((options.platform ?? process.platform) !== "win32")
        throw new Error("Windows packaging requires a Windows x64 runner.");
    await preparePinnedTauriWindowsBundlerTools(options);
    await buildLockedTauri(
        [
            "--ci",
            "--target",
            DESKTOP_RUST_TARGET.WindowsX64,
            "--bundles",
            "nsis",
            "--no-sign",
            "--config",
            JSON.stringify(WINDOWS_BUNDLE_CONFIG),
        ],
        options,
    );
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
    if (process.argv.slice(2).join(" ") !== "--build")
        throw new Error(
            "Usage: prepare-tauri-windows-bundler-tools.mjs --build",
        );
    await buildPinnedTauriWindowsBundle();
}
