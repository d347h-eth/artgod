import { createHash } from "node:crypto";
import {
    chmod,
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    DEFAULT_MINIMUM_AGE_DAYS,
    calculateCutoffDate,
} from "../security/dependency-age-policy.mjs";
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
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_REVISION_PATTERN = /^[a-f0-9]{40}$/;
const GITHUB_RELEASE_ASSET_URL_PATTERN =
    /^https:\/\/api\.github\.com\/repos\/[\w.-]+\/[\w.-]+\/releases\/assets\/[1-9][0-9]*$/;
const GITHUB_RAW_CONTENT_ORIGIN = "https://raw.githubusercontent.com";
const BINARY_DOWNLOAD_MEDIA_TYPE = "application/octet-stream";
const GITHUB_METADATA_MEDIA_TYPE = "application/vnd.github+json";
const RELEASE_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MOVING_RELEASE_TAG_PATTERN =
    /^(continuous|latest|nightly|rolling|dev|master|main|head)$/i;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const EXECUTABLE_FILE_MODE = 0o755;
const TOOLS_DIRECTORY_MODE = 0o700;
const DOWNLOAD_FILE_MODE = 0o600;
const DOWNLOAD_UMASK = 0o077;
const TAURI_TOOLS_CACHE_DIRECTORY_NAME = "tauri";

// The output plugin forwards this path to appimagetool's --runtime-file option.
export const TAURI_LINUX_APPIMAGE_RUNTIME_ENV_KEY = "LDAI_RUNTIME_FILE";
export const TAURI_LINUX_APPIMAGE_RUNTIME_FILE_NAME = "runtime-x86_64";
export const TAURI_LINUX_APPIMAGE_OUTPUT_PLUGIN_FILE_NAME =
    "linuxdeploy-plugin-appimage.AppImage";

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
        `For Tauri builds, set ${TAURI_LINUX_APPIMAGE_RUNTIME_ENV_KEY}=${path.join(resolveTauriToolsCacheDirectory(), TAURI_LINUX_APPIMAGE_RUNTIME_FILE_NAME)}.`,
    );
}

// Keep preparation and runtime selection in the process that launches Tauri;
// a missing shell export would otherwise enable appimagetool's live download.
export async function buildPinnedTauriLinuxBundle(options = {}) {
    const environment = options.environment ?? process.env;
    const cacheDirectory = path.resolve(
        options.cacheDirectory ?? resolveTauriToolsCacheDirectory(environment),
    );
    if (path.basename(cacheDirectory) !== TAURI_TOOLS_CACHE_DIRECTORY_NAME) {
        throw new Error("Linux bundle cache directory must be named tauri.");
    }
    await preparePinnedTauriLinuxBundlerTools({ ...options, cacheDirectory });
    const buildCacheDirectory = await stageTauriLinuxBundleTools({
        cacheDirectory,
        temporaryRoot: options.temporaryRoot,
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
            JSON.stringify({ bundle: { useLocalToolsDir: false } }),
            "--",
            "--locked",
        ],
        {
            cwd: rootDir,
            env: {
                ...environment,
                XDG_CACHE_HOME: path.dirname(buildCacheDirectory),
                [TAURI_LINUX_APPIMAGE_RUNTIME_ENV_KEY]: path.join(
                    buildCacheDirectory,
                    TAURI_LINUX_APPIMAGE_RUNTIME_FILE_NAME,
                ),
            },
            stream: true,
        },
    );
}

// Preserve the verified cache bytes. Tauri mutates linuxdeploy's ELF header,
// and our output adapter must live beside it to win plugin discovery. Keep the
// isolated build directory under tmp for inspection after a failed bundle.
export async function stageTauriLinuxBundleTools({
    cacheDirectory,
    temporaryRoot = path.join(rootDir, "tmp"),
}) {
    await mkdir(temporaryRoot, { recursive: true });
    const buildRoot = await mkdtemp(
        path.join(temporaryRoot, "tauri-linux-bundle-"),
    );
    const buildCacheDirectory = path.join(
        buildRoot,
        TAURI_TOOLS_CACHE_DIRECTORY_NAME,
    );
    await mkdir(buildCacheDirectory, { mode: TOOLS_DIRECTORY_MODE });
    for (const fileName of TAURI_LINUX_BUNDLER_TOOL_FILE_NAMES) {
        await copyFile(
            path.join(cacheDirectory, fileName),
            path.join(buildCacheDirectory, fileName),
        );
    }
    const outputPluginPath = path.join(
        buildCacheDirectory,
        TAURI_LINUX_APPIMAGE_OUTPUT_PLUGIN_FILE_NAME,
    );
    const pinnedOutputPluginPath = path.join(
        buildCacheDirectory,
        ".pinned-appimage-plugin",
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
    return buildCacheDirectory;
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
    if (
        !Number.isSafeInteger(manifest.minimumAgeDays) ||
        manifest.minimumAgeDays < DEFAULT_MINIMUM_AGE_DAYS
    ) {
        throw new Error(
            `Pinned Tauri Linux tools require a minimum age of at least ${DEFAULT_MINIMUM_AGE_DAYS} days.`,
        );
    }
    const cutoffDate = calculateCutoffDate(now, manifest.minimumAgeDays);
    if (!Number.isFinite(cutoffDate.getTime())) {
        throw new Error("Pinned Tauri Linux tools have an invalid age cutoff.");
    }

    const toolsByFileName = new Map();
    for (const tool of manifest.tools) {
        validatePinnedToolRecord(tool);
        if (new Date(tool.publishedAt) > cutoffDate) {
            throw new Error(
                `Pinned Tauri Linux tool ${tool.fileName} was published ${tool.publishedAt}; the ${manifest.minimumAgeDays}-day age gate requires publication on or before ${cutoffDate.toISOString()}.`,
            );
        }
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
    const destinationPath = path.join(cacheDirectory, tool.fileName);
    if (await fileMatchesPinnedTool(destinationPath, tool)) {
        await chmod(destinationPath, EXECUTABLE_FILE_MODE);
        return;
    }

    // Check the selected release/commit as well as its bytes. An asset ID alone
    // does not prove that an upload belongs to a retained, age-qualified release.
    await verifyPinnedToolProvenance(tool, fetchImplementation);
    // Asset APIs otherwise return JSON metadata; public binary downloads need no token.
    const response = await fetchImplementation(tool.url, {
        headers: { Accept: BINARY_DOWNLOAD_MEDIA_TYPE },
    });
    if (!response.ok) {
        throw new Error(
            `Failed to download pinned Tauri Linux tool ${tool.fileName}: HTTP ${response.status} ${response.statusText}.`,
        );
    }

    const content = Buffer.from(await response.arrayBuffer());
    assertPinnedToolBytes(tool, content);
    const temporaryPath = path.join(temporaryDirectory, tool.fileName);
    await writeFile(temporaryPath, content, { mode: DOWNLOAD_FILE_MODE });
    await chmod(temporaryPath, EXECUTABLE_FILE_MODE);
    await rename(temporaryPath, destinationPath);
}

async function verifyPinnedToolProvenance(tool, fetchImplementation) {
    const url = new URL(tool.url);
    const pathParts = url.pathname.split("/");
    const repository = tool.fileName.endsWith(".sh")
        ? `${pathParts[1]}/${pathParts[2]}`
        : `${pathParts[2]}/${pathParts[3]}`;
    const metadataUrl = tool.fileName.endsWith(".sh")
        ? `https://api.github.com/repos/${repository}/commits/${tool.sourceRevision}`
        : `https://api.github.com/repos/${repository}/releases/tags/${tool.releaseTag}`;
    const response = await fetchImplementation(metadataUrl, {
        headers: { Accept: GITHUB_METADATA_MEDIA_TYPE },
    });
    if (!response.ok) {
        throw new Error(
            `Failed to verify pinned Tauri Linux tool ${tool.fileName} provenance: HTTP ${response.status} ${response.statusText}.`,
        );
    }
    const metadata = await response.json();
    let publishedAt;
    if (tool.fileName.endsWith(".sh")) {
        if (metadata.sha !== tool.sourceRevision) {
            throw new Error(`Pinned tool ${tool.fileName} commit mismatch.`);
        }
        publishedAt = metadata.commit?.committer?.date;
    } else {
        const assetId = Number(pathParts.at(-1));
        const asset = metadata.assets?.find((asset) => asset.id === assetId);
        if (
            metadata.tag_name !== tool.releaseTag ||
            metadata.draft !== false ||
            !asset ||
            asset.name !== tool.assetName ||
            asset.size !== tool.sizeBytes ||
            (tool.sourceRevision &&
                metadata.target_commitish !== tool.sourceRevision) ||
            (asset.digest && asset.digest !== `sha256:${tool.sha256}`)
        ) {
            throw new Error(
                `Pinned tool ${tool.fileName} release asset metadata mismatch.`,
            );
        }
        // An old tag can receive new uploads. Use the latest publication/upload
        // timestamp, never the tag name or source commit's age as a substitute.
        const dates = [
            metadata.published_at,
            asset.created_at,
            asset.updated_at,
        ];
        dates.forEach((value) => assertUtcTimestamp(value, tool.fileName));
        publishedAt = dates.sort().at(-1);
    }
    assertUtcTimestamp(publishedAt, tool.fileName);
    if (publishedAt !== tool.publishedAt) {
        throw new Error(
            `Pinned tool ${tool.fileName} publication timestamp mismatch: expected ${tool.publishedAt}, received ${publishedAt}.`,
        );
    }
}

async function fileMatchesPinnedTool(filePath, tool) {
    try {
        const fileStat = await stat(filePath);
        if (!fileStat.isFile() || fileStat.size !== tool.sizeBytes) {
            return false;
        }
        const content = await readFile(filePath);
        return sha256(content) === tool.sha256;
    } catch (error) {
        if (error?.code === "ENOENT") {
            return false;
        }
        throw error;
    }
}

function assertPinnedToolBytes(tool, content) {
    if (content.length !== tool.sizeBytes) {
        throw new Error(
            `Pinned Tauri Linux tool ${tool.fileName} size mismatch. Expected ${tool.sizeBytes}, received ${content.length}.`,
        );
    }
    const actualSha256 = sha256(content);
    if (actualSha256 !== tool.sha256) {
        throw new Error(
            `Pinned Tauri Linux tool ${tool.fileName} SHA-256 mismatch. Expected ${tool.sha256}, received ${actualSha256}.`,
        );
    }
}

function validatePinnedToolRecord(tool) {
    if (!tool || typeof tool !== "object") {
        throw new Error("Pinned Tauri Linux tool entry must be an object.");
    }
    if (
        typeof tool.fileName !== "string" ||
        path.basename(tool.fileName) !== tool.fileName
    ) {
        throw new Error("Pinned Tauri Linux tool has an invalid file name.");
    }
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
    if (!Number.isSafeInteger(tool.sizeBytes) || tool.sizeBytes <= 0) {
        throw new Error(
            `Pinned Tauri Linux tool ${tool.fileName} has an invalid size.`,
        );
    }
    if (!SHA256_PATTERN.test(tool.sha256)) {
        throw new Error(
            `Pinned Tauri Linux tool ${tool.fileName} has an invalid SHA-256.`,
        );
    }
}

function assertUtcTimestamp(value, fileName) {
    const timestamp = new Date(value);
    if (
        typeof value !== "string" ||
        !UTC_TIMESTAMP_PATTERN.test(value) ||
        Number.isNaN(timestamp.getTime()) ||
        timestamp.toISOString().replace(".000Z", "Z") !== value
    ) {
        throw new Error(
            `Pinned tool ${fileName} has an invalid publication timestamp.`,
        );
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

function sha256(content) {
    return createHash("sha256").update(content).digest("hex");
}

const isMainModule =
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMainModule) {
    await main();
}
