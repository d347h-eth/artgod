import {
    chmod,
    copyFile,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    GITHUB_METADATA_MEDIA_TYPE,
    GITHUB_RELEASE_ASSET_URL_PATTERN,
    assertInputPublicationTimestamp as assertUtcTimestamp,
    assertPinnedInputAge,
    assertPinnedInputBytesContract,
    materializePinnedInput,
    verifyGithubReleaseInputProvenance,
} from "./pinned-build-inputs.mjs";
import { runRedactedCommand } from "./secret-output-redaction.mjs";

const rootDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
);
const pinnedToolsManifestPath = path.join(
    rootDir,
    "config",
    "tauri-linux-bundler-tools.json",
);
const rootPackageJsonPath = path.join(rootDir, "package.json");

const PINNED_TOOLS_SCHEMA_VERSION = 2;
export const TAURI_LINUX_BUNDLER_TARGET = "x86_64-unknown-linux-gnu";
export const TAURI_LINUX_BUNDLE_BUILD_SCRIPT_NAME =
    "build:desktop:linux-bundle";
const TAURI_CLI_PACKAGE_NAME = "@tauri-apps/cli";
const GIT_REVISION_PATTERN = /^[a-f0-9]{40}$/;
const GITHUB_RAW_CONTENT_ORIGIN = "https://raw.githubusercontent.com";
const RELEASE_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MOVING_RELEASE_TAG_PATTERN =
    /^(continuous|latest|nightly|rolling|dev|master|main|head)$/i;
const EXECUTABLE_FILE_MODE = 0o755;
const TOOLS_DIRECTORY_MODE = 0o700;
const DOWNLOAD_UMASK = 0o077;
const TAURI_TOOLS_CACHE_DIRECTORY_NAME = "tauri";
export const TAURI_LOCAL_TOOLS_DIRECTORY_NAME = ".tauri";

// The output plugin forwards this path to appimagetool's --runtime-file option.
export const TAURI_LINUX_APPIMAGE_RUNTIME_ENV_KEY = "LDAI_RUNTIME_FILE";
export const TAURI_LINUX_APPIMAGE_RUNTIME_FILE_NAME = "runtime-x86_64";
export const TAURI_LINUX_APPIMAGE_OUTPUT_PLUGIN_FILE_NAME =
    "linuxdeploy-plugin-appimage.AppImage";
export const TAURI_LINUX_APPIMAGE_PINNED_PLUGIN_FILE_NAME =
    ".pinned-appimage-plugin";

// Exact tools and embedded runtime consumed by the Tauri 2.11.3 Linux bundler.
export const TAURI_LINUX_BUNDLER_TOOL_FILE_NAMES = Object.freeze([
    "AppRun-x86_64",
    "linuxdeploy-x86_64.AppImage",
    "linuxdeploy-plugin-gtk.sh",
    "linuxdeploy-plugin-gstreamer.sh",
    TAURI_LINUX_APPIMAGE_OUTPUT_PLUGIN_FILE_NAME,
    TAURI_LINUX_APPIMAGE_RUNTIME_FILE_NAME,
]);

async function main() {
    if (process.platform !== "linux" || process.arch !== "x64") {
        throw new Error(
            "Pinned Tauri Linux bundler tools require a Linux x64 host.",
        );
    }
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--build") {
        await buildPinnedTauriLinuxBundle();
        return;
    }
    if (args.length > 0) {
        throw new Error(
            "Usage: prepare-tauri-linux-bundler-tools.mjs [--build]",
        );
    }
    await preparePinnedTauriLinuxBundlerTools();
    console.log(
        `Verified Linux bundler inputs are cached. Build with yarn ${TAURI_LINUX_BUNDLE_BUILD_SCRIPT_NAME}.`,
    );
}

// Keep preparation and runtime selection in the process that launches Tauri;
// a missing shell export would otherwise enable appimagetool's live download.
export async function buildPinnedTauriLinuxBundle(options = {}) {
    const environment = options.environment ?? process.env;
    const cacheDirectory = path.resolve(
        options.cacheDirectory ?? resolveTauriToolsCacheDirectory(environment),
    );
    await preparePinnedTauriLinuxBundlerTools({ ...options, cacheDirectory });
    const localToolsDirectory = await resolveTauriLocalToolsDirectory({
        environment,
        runCommand: options.runCommand,
    });
    await stageTauriLinuxBundleTools({
        cacheDirectory,
        localToolsDirectory,
    });
    const runBuild = options.runBuild ?? runRedactedCommand;
    await runBuild(
        "yarn",
        [
            "tauri",
            "build",
            "--ci",
            "--target",
            TAURI_LINUX_BUNDLER_TARGET,
            "--bundles",
            "appimage,deb",
            "--config",
            JSON.stringify({ bundle: { useLocalToolsDir: true } }),
            "--",
            "--locked",
        ],
        {
            cwd: rootDir,
            env: {
                ...environment,
                [TAURI_LINUX_APPIMAGE_RUNTIME_ENV_KEY]: path.join(
                    localToolsDirectory,
                    TAURI_LINUX_APPIMAGE_RUNTIME_FILE_NAME,
                ),
            },
            stream: true,
        },
    );
}

// Match the pinned Tauri CLI's local-tools resolution through Cargo metadata,
// including CARGO_TARGET_DIR and Cargo configuration. Do not guess src-tauri/target
// or redirect unrelated caches to select the packaging tools.
export async function resolveTauriLocalToolsDirectory({
    environment = process.env,
    runCommand = runRedactedCommand,
} = {}) {
    const result = await runCommand(
        "cargo",
        ["metadata", "--no-deps", "--format-version", "1", "--locked"],
        { cwd: path.join(rootDir, "src-tauri"), env: environment },
    );
    const metadata = JSON.parse(result.stdout);
    if (
        typeof metadata?.target_directory !== "string" ||
        !path.isAbsolute(metadata.target_directory)
    ) {
        throw new Error(
            "Cargo metadata must provide an absolute target_directory for Tauri's local tools.",
        );
    }
    return path.join(
        metadata.target_directory,
        TAURI_LOCAL_TOOLS_DIRECTORY_NAME,
    );
}

// Tauri mutates linuxdeploy's ELF header. Refresh only our execution copies and
// adapter before each sequential build, preserving verified originals and other
// Tauri tools that may share target/.tauri (for example, Windows packagers).
export async function stageTauriLinuxBundleTools({
    cacheDirectory,
    localToolsDirectory,
}) {
    await mkdir(localToolsDirectory, {
        recursive: true,
        mode: TOOLS_DIRECTORY_MODE,
    });
    if (!(await lstat(localToolsDirectory)).isDirectory()) {
        throw new Error(
            "Tauri's local tools path must be a directory, not a link.",
        );
    }
    if (
        (await realpath(localToolsDirectory)) ===
        (await realpath(cacheDirectory))
    ) {
        throw new Error(
            "Tauri's execution tools must be separate from the verified cache.",
        );
    }
    await chmod(localToolsDirectory, TOOLS_DIRECTORY_MODE);
    for (const fileName of TAURI_LINUX_BUNDLER_TOOL_FILE_NAMES) {
        // Unlink stale entries first so a symlink cannot redirect a copy into
        // the immutable input cache. A failed refresh never launches Tauri.
        const destinationPath = path.join(localToolsDirectory, fileName);
        await rm(destinationPath, { force: true });
        await copyFile(path.join(cacheDirectory, fileName), destinationPath);
    }
    const outputPluginPath = path.join(
        localToolsDirectory,
        TAURI_LINUX_APPIMAGE_OUTPUT_PLUGIN_FILE_NAME,
    );
    const pinnedOutputPluginPath = path.join(
        localToolsDirectory,
        TAURI_LINUX_APPIMAGE_PINNED_PLUGIN_FILE_NAME,
    );
    await rename(outputPluginPath, pinnedOutputPluginPath);
    const policyScriptPath = fileURLToPath(
        new URL("./linux-appimage-host-libraries.mjs", import.meta.url),
    );
    // Shell arguments may contain spaces, quotes, or shell metacharacters.
    const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(
        outputPluginPath,
        [
            "#!/bin/sh",
            "set -eu",
            `${shellQuote(process.execPath)} ${shellQuote(policyScriptPath)} "$@"`,
            `exec ${shellQuote(pinnedOutputPluginPath)} "$@"`,
            "",
        ].join("\n"),
        { mode: EXECUTABLE_FILE_MODE },
    );
    return localToolsDirectory;
}

// Materializes only manifest-pinned executable bytes in Tauri's Linux cache.
export async function preparePinnedTauriLinuxBundlerTools(options = {}) {
    const manifestPath = path.resolve(
        options.manifestPath ?? pinnedToolsManifestPath,
    );
    const cacheDirectory = path.resolve(
        options.cacheDirectory ?? resolveTauriToolsCacheDirectory(),
    );
    const fetchImplementation = options.fetchImplementation ?? fetch;
    const logger = options.logger ?? console.log;
    const expectedTauriCliVersion =
        options.expectedTauriCliVersion ??
        (await readConfiguredTauriCliVersion(rootPackageJsonPath));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const tools = validatePinnedToolsManifest(
        manifest,
        expectedTauriCliVersion,
        options.now ?? new Date(),
    );
    const previousUmask = process.umask(DOWNLOAD_UMASK);
    let temporaryDirectory;

    try {
        await mkdir(cacheDirectory, {
            recursive: true,
            mode: TOOLS_DIRECTORY_MODE,
        });
        await chmod(cacheDirectory, TOOLS_DIRECTORY_MODE);
        temporaryDirectory = await mkdtemp(
            path.join(cacheDirectory, ".artgod-download-"),
        );

        for (const tool of tools) {
            await materializePinnedTool({
                tool,
                cacheDirectory,
                temporaryDirectory,
                fetchImplementation,
            });
            logger(
                `Verified pinned Tauri Linux tool ${tool.fileName} (${tool.sha256}).`,
            );
        }
    } finally {
        if (temporaryDirectory) {
            await rm(temporaryDirectory, { recursive: true, force: true });
        }
        process.umask(previousUmask);
    }
}

// Resolves the same Linux cache root used by the Rust `dirs` crate.
export function resolveTauriToolsCacheDirectory(environment = process.env) {
    const xdgCacheHome = environment.XDG_CACHE_HOME;
    const cacheRoot =
        typeof xdgCacheHome === "string" && path.isAbsolute(xdgCacheHome)
            ? xdgCacheHome
            : path.join(os.homedir(), ".cache");
    return path.join(cacheRoot, TAURI_TOOLS_CACHE_DIRECTORY_NAME);
}

// Rejects incomplete manifests so Tauri cannot silently download a missing tool.
export function validatePinnedToolsManifest(
    manifest,
    expectedTauriCliVersion,
    now = new Date(),
) {
    if (manifest?.schemaVersion !== PINNED_TOOLS_SCHEMA_VERSION) {
        throw new Error("Unsupported Tauri Linux tool manifest schema.");
    }
    if (manifest.tauriCliVersion !== expectedTauriCliVersion) {
        throw new Error(
            `Pinned Tauri Linux tools target CLI ${manifest.tauriCliVersion}, but package.json selects ${expectedTauriCliVersion}.`,
        );
    }
    if (manifest.target !== TAURI_LINUX_BUNDLER_TARGET) {
        throw new Error(
            `Pinned Tauri Linux tools must target ${TAURI_LINUX_BUNDLER_TARGET}.`,
        );
    }
    if (!Array.isArray(manifest.tools)) {
        throw new Error("Pinned Tauri Linux tool manifest has no tools array.");
    }
    const toolsByFileName = new Map();
    for (const tool of manifest.tools) {
        validatePinnedToolRecord(tool);
        assertPinnedInputAge(tool, manifest.minimumAgeDays, now);
        if (toolsByFileName.has(tool.fileName)) {
            throw new Error(
                `Duplicate pinned Tauri Linux tool ${tool.fileName}.`,
            );
        }
        toolsByFileName.set(tool.fileName, Object.freeze({ ...tool }));
    }

    const requiredFileNames = new Set(TAURI_LINUX_BUNDLER_TOOL_FILE_NAMES);
    const unexpectedFileNames = [...toolsByFileName.keys()].filter(
        (fileName) => !requiredFileNames.has(fileName),
    );
    const missingFileNames = TAURI_LINUX_BUNDLER_TOOL_FILE_NAMES.filter(
        (fileName) => !toolsByFileName.has(fileName),
    );
    if (unexpectedFileNames.length > 0 || missingFileNames.length > 0) {
        throw new Error(
            `Pinned Tauri Linux tool set mismatch. Missing: ${missingFileNames.join(", ") || "none"}. Unexpected: ${unexpectedFileNames.join(", ") || "none"}.`,
        );
    }

    return TAURI_LINUX_BUNDLER_TOOL_FILE_NAMES.map((fileName) =>
        toolsByFileName.get(fileName),
    );
}

async function materializePinnedTool({
    tool,
    cacheDirectory,
    temporaryDirectory,
    fetchImplementation,
}) {
    await materializePinnedInput({
        input: tool,
        destinationPath: path.join(cacheDirectory, tool.fileName),
        temporaryDirectory,
        verifyProvenance: verifyPinnedToolProvenance,
        fetchImplementation,
        mode: EXECUTABLE_FILE_MODE,
    });
}

async function verifyPinnedToolProvenance(tool, fetchImplementation) {
    if (!tool.fileName.endsWith(".sh")) {
        await verifyGithubReleaseInputProvenance(tool, fetchImplementation);
        return;
    }
    const url = new URL(tool.url);
    const pathParts = url.pathname.split("/");
    const repository = `${pathParts[1]}/${pathParts[2]}`;
    const metadataUrl = `https://api.github.com/repos/${repository}/commits/${tool.sourceRevision}`;
    const response = await fetchImplementation(metadataUrl, {
        headers: { Accept: GITHUB_METADATA_MEDIA_TYPE },
    });
    if (!response.ok) {
        throw new Error(
            `Failed to verify pinned Tauri Linux tool ${tool.fileName} provenance: HTTP ${response.status} ${response.statusText}.`,
        );
    }
    const metadata = await response.json();
    if (metadata.sha !== tool.sourceRevision) {
        throw new Error(`Pinned tool ${tool.fileName} commit mismatch.`);
    }
    const publishedAt = metadata.commit?.committer?.date;
    assertUtcTimestamp(publishedAt, tool.fileName);
    if (publishedAt !== tool.publishedAt) {
        throw new Error(
            `Pinned tool ${tool.fileName} publication timestamp mismatch: expected ${tool.publishedAt}, received ${publishedAt}.`,
        );
    }
}

function validatePinnedToolRecord(tool) {
    assertPinnedInputBytesContract(tool);
    if (
        typeof tool.url !== "string" ||
        new URL(tool.url).protocol !== "https:"
    ) {
        throw new Error(
            `Pinned Tauri Linux tool ${tool.fileName} must use HTTPS.`,
        );
    }
    // Scripts require the exact source revision. Binary mirrors may expose only
    // an upload identity; do not mistake the mirror repository's head for the
    // source revision compiled into an uploaded executable.
    if (
        (tool.fileName.endsWith(".sh") || tool.sourceRevision !== undefined) &&
        !GIT_REVISION_PATTERN.test(tool.sourceRevision)
    ) {
        throw new Error(
            `Pinned Tauri Linux tool ${tool.fileName} has an invalid source revision.`,
        );
    }
    validatePinnedToolDownloadUrl(tool);
    assertUtcTimestamp(tool.publishedAt, tool.fileName);
    if (!tool.fileName.endsWith(".sh")) {
        if (
            !RELEASE_TAG_PATTERN.test(tool.releaseTag ?? "") ||
            MOVING_RELEASE_TAG_PATTERN.test(tool.releaseTag)
        ) {
            throw new Error(
                `Pinned tool ${tool.fileName} must select a retained release, not a moving release alias.`,
            );
        }
        if (
            typeof tool.assetName !== "string" ||
            !tool.assetName ||
            path.basename(tool.assetName) !== tool.assetName
        ) {
            throw new Error(
                `Pinned tool ${tool.fileName} has an invalid asset name.`,
            );
        }
    }
}

// Pin an upload's identity instead of resolving a release tag that can be replaced.
function validatePinnedToolDownloadUrl(tool) {
    if (!tool.fileName.endsWith(".sh")) {
        if (!GITHUB_RELEASE_ASSET_URL_PATTERN.test(tool.url)) {
            throw new Error(
                `Pinned Tauri Linux tool ${tool.fileName} must use a GitHub release asset ID URL.`,
            );
        }
        return;
    }

    const url = new URL(tool.url);
    const pathParts = url.pathname.split("/");
    if (
        url.origin !== GITHUB_RAW_CONTENT_ORIGIN ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        pathParts.length !== 5 ||
        !pathParts[1] ||
        !pathParts[2] ||
        pathParts[3] !== tool.sourceRevision ||
        pathParts[4] !== tool.fileName
    ) {
        throw new Error(
            `Pinned Tauri Linux tool ${tool.fileName} URL must select its declared source revision.`,
        );
    }
}

async function readConfiguredTauriCliVersion(packageJsonPath) {
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    const version = packageJson.devDependencies?.[TAURI_CLI_PACKAGE_NAME];
    if (typeof version !== "string" || !version.trim()) {
        throw new Error(
            `package.json must select an exact ${TAURI_CLI_PACKAGE_NAME} version.`,
        );
    }
    return version.trim();
}

const isMainModule =
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMainModule) {
    await main();
}
