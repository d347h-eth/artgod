import { createHash } from "node:crypto";
import {
    chmod,
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

const PINNED_TOOLS_SCHEMA_VERSION = 1;
const PINNED_TOOLS_TARGET = "x86_64-unknown-linux-gnu";
const TAURI_CLI_PACKAGE_NAME = "@tauri-apps/cli";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_REVISION_PATTERN = /^[a-f0-9]{40}$/;
const EXECUTABLE_FILE_MODE = 0o755;
const TOOLS_DIRECTORY_MODE = 0o700;
const DOWNLOAD_FILE_MODE = 0o600;
const DOWNLOAD_UMASK = 0o077;

// Exact cache entries consumed by the Tauri 2.11.3 Linux AppImage bundler.
export const TAURI_LINUX_BUNDLER_TOOL_FILE_NAMES = Object.freeze([
    "AppRun-x86_64",
    "linuxdeploy-x86_64.AppImage",
    "linuxdeploy-plugin-gtk.sh",
    "linuxdeploy-plugin-gstreamer.sh",
    "linuxdeploy-plugin-appimage.AppImage",
]);

async function main() {
    if (process.platform !== "linux" || process.arch !== "x64") {
        throw new Error(
            "Pinned Tauri Linux bundler tools require a Linux x64 host.",
        );
    }

    await preparePinnedTauriLinuxBundlerTools();
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
    const cacheRoot =
        environment.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), ".cache");
    return path.join(cacheRoot, "tauri");
}

// Rejects incomplete manifests so Tauri cannot silently download a missing tool.
export function validatePinnedToolsManifest(manifest, expectedTauriCliVersion) {
    if (manifest?.schemaVersion !== PINNED_TOOLS_SCHEMA_VERSION) {
        throw new Error("Unsupported Tauri Linux tool manifest schema.");
    }
    if (manifest.tauriCliVersion !== expectedTauriCliVersion) {
        throw new Error(
            `Pinned Tauri Linux tools target CLI ${manifest.tauriCliVersion}, but package.json selects ${expectedTauriCliVersion}.`,
        );
    }
    if (manifest.target !== PINNED_TOOLS_TARGET) {
        throw new Error(
            `Pinned Tauri Linux tools must target ${PINNED_TOOLS_TARGET}.`,
        );
    }
    if (!Array.isArray(manifest.tools)) {
        throw new Error("Pinned Tauri Linux tool manifest has no tools array.");
    }

    const toolsByFileName = new Map();
    for (const tool of manifest.tools) {
        validatePinnedToolRecord(tool);
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

    await rm(destinationPath, { force: true });
    const response = await fetchImplementation(tool.url);
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
    if (!GIT_REVISION_PATTERN.test(tool.sourceRevision)) {
        throw new Error(
            `Pinned Tauri Linux tool ${tool.fileName} has an invalid source revision.`,
        );
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
