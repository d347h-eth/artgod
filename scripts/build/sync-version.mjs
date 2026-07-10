#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
);

const COMMAND_CHECK = "--check";
const ROOT_PACKAGE_PATH = "package.json";
const WORKSPACE_PACKAGE_PATHS = Object.freeze([
    "backend/package.json",
    "database/package.json",
    "frontend/package.json",
    "indexer/package.json",
    "shared/package.json",
    "trading/package.json",
]);
const DESKTOP_CONFIG_PATH = "src-tauri/tauri.conf.json";
const CARGO_MANIFEST_PATH = "src-tauri/Cargo.toml";
const CARGO_LOCK_PATH = "src-tauri/Cargo.lock";
const OPENAPI_DOCUMENT_PATH = "docs/backend-api.openapi.yaml";
const CARGO_MANIFEST_VERSION_PATTERN = /^version = "([^"]*)"$/m;
const CARGO_LOCK_VERSION_PATTERN =
    /name = "artgod-desktop"\r?\nversion = "([^"]*)"/m;
const OPENAPI_VERSION_PATTERN = /^    version: (.+)$/m;

const VERSION_TARGETS = Object.freeze([
    ...WORKSPACE_PACKAGE_PATHS.map((relativePath) =>
        createJsonVersionTarget(relativePath),
    ),
    createJsonVersionTarget(DESKTOP_CONFIG_PATH),
    createTextVersionTarget(
        CARGO_MANIFEST_PATH,
        CARGO_MANIFEST_VERSION_PATTERN,
        (version) => `version = "${version}"`,
    ),
    createTextVersionTarget(
        CARGO_LOCK_PATH,
        CARGO_LOCK_VERSION_PATTERN,
        (version) => `name = "artgod-desktop"\nversion = "${version}"`,
    ),
    createTextVersionTarget(
        OPENAPI_DOCUMENT_PATH,
        OPENAPI_VERSION_PATTERN,
        (version) => `    version: ${version}`,
    ),
]);

// Lists every non-canonical file governed by the project version contract.
export const PROJECT_VERSION_TARGET_PATHS = Object.freeze(
    VERSION_TARGETS.map(({ relativePath }) => relativePath),
);

// Lists the canonical package file and every synchronized version target.
export const PROJECT_VERSION_FILE_PATHS = Object.freeze([
    ROOT_PACKAGE_PATH,
    ...PROJECT_VERSION_TARGET_PATHS,
]);

// Reads the canonical project version from the root package manifest.
export async function readCanonicalProjectVersion(projectRoot = rootDir) {
    const rootPackage = await readJsonFile(
        path.join(projectRoot, ROOT_PACKAGE_PATH),
    );
    const version = readSerializedVersion(rootPackage.version);
    if (!version || version.trim() !== version) {
        throw new Error(
            "Root package.json version is missing or contains surrounding whitespace.",
        );
    }
    return version;
}

// Reports targets whose serialized version differs from the canonical version.
export async function findProjectVersionMismatches(
    projectRoot = rootDir,
    expectedVersion,
) {
    const version =
        expectedVersion ?? (await readCanonicalProjectVersion(projectRoot));
    const mismatches = [];

    for (const target of VERSION_TARGETS) {
        const source = await readFile(
            path.join(projectRoot, target.relativePath),
            "utf8",
        );
        const actualVersion = target.readVersion(source);
        if (actualVersion !== version) {
            mismatches.push({
                relativePath: target.relativePath,
                actualVersion,
                expectedVersion: version,
            });
        }
    }

    return mismatches;
}

// Fails without modifying files when any project version target has drifted.
export async function assertProjectVersionsSynchronized(projectRoot = rootDir) {
    const version = await readCanonicalProjectVersion(projectRoot);
    const mismatches = await findProjectVersionMismatches(projectRoot, version);
    if (mismatches.length > 0) {
        const details = mismatches
            .map(
                ({ relativePath, actualVersion }) =>
                    `${relativePath}=${JSON.stringify(actualVersion)}`,
            )
            .join(", ");
        throw new Error(
            `Project version ${version} is not synchronized: ${details}. Run yarn sync:version.`,
        );
    }
    return version;
}

// Writes the canonical root version to every governed project file.
export async function synchronizeProjectVersion(projectRoot = rootDir) {
    const version = await readCanonicalProjectVersion(projectRoot);
    const updatedPaths = [];

    for (const target of VERSION_TARGETS) {
        const targetPath = path.join(projectRoot, target.relativePath);
        const source = await readFile(targetPath, "utf8");
        const updated = target.writeVersion(source, version);
        if (updated === source) {
            continue;
        }
        await writeFile(targetPath, updated, "utf8");
        updatedPaths.push(target.relativePath);
    }

    return { version, updatedPaths };
}

function createJsonVersionTarget(relativePath) {
    return Object.freeze({
        relativePath,
        readVersion(source) {
            return readSerializedVersion(JSON.parse(source).version);
        },
        writeVersion(source, version) {
            const value = JSON.parse(source);
            if (readSerializedVersion(value.version) === version) {
                return source;
            }
            value.version = version;
            return `${JSON.stringify(value, null, 4)}\n`;
        },
    });
}

function createTextVersionTarget(relativePath, pattern, createReplacement) {
    const readVersion = (source) => {
        const match = source.match(pattern);
        if (!match) {
            throw new Error(
                `Expected version marker not found in ${relativePath}.`,
            );
        }
        return readSerializedVersion(match[1]);
    };
    return Object.freeze({
        relativePath,
        readVersion,
        writeVersion(source, version) {
            const currentVersion = readVersion(source);
            if (currentVersion === version) {
                return source;
            }
            return source.replace(pattern, createReplacement(version));
        },
    });
}

async function readJsonFile(filePath) {
    return JSON.parse(await readFile(filePath, "utf8"));
}

function readSerializedVersion(value) {
    return typeof value === "string" ? value : "";
}

async function main() {
    const [command, ...unexpectedArguments] = process.argv.slice(2);
    if (
        unexpectedArguments.length > 0 ||
        (command && command !== COMMAND_CHECK)
    ) {
        throw new Error(
            `Usage: node scripts/build/sync-version.mjs [${COMMAND_CHECK}]`,
        );
    }

    if (command === COMMAND_CHECK) {
        const version = await assertProjectVersionsSynchronized(rootDir);
        console.log(`Project version ${version} is synchronized.`);
        return;
    }

    const { version, updatedPaths } = await synchronizeProjectVersion(rootDir);
    console.log(
        updatedPaths.length > 0
            ? `Synchronized project version ${version} across ${updatedPaths.length} files.`
            : `Project version ${version} was already synchronized.`,
    );
}

const isMainModule =
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMainModule) {
    try {
        await main();
    } catch (error) {
        console.error(error instanceof Error ? error.stack : String(error));
        process.exitCode = 1;
    }
}
