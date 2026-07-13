#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(scriptPath), "../..");
const appImageExtension = ".AppImage";
const debExtension = ".deb";
const appImageExtractedDirectoryName = "squashfs-root";
const linuxSharedResourcesDirectoryName = "share";
const linuxPrivateResourcesDirectoryName = "lib";
export const WALLET_RECIPIENT_INTEGRITY_SNAPSHOT_FILE_NAME =
    ".artgod-wallet-recipient-integrity.json";
export const WALLET_RECIPIENT_INTEGRITY_SNAPSHOT_VERSION = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const EXECUTABLE_MODE_MASK = 0o111;

// Verifies that Linux packaging preserved every staged runtime byte and file type.
export async function verifyLinuxBundledRuntime({
    bundleRoot,
    stagedRuntimeRoot,
    integritySnapshotPath,
    productName,
    commandRunner = runCommand,
    temporaryRoot = os.tmpdir(),
}) {
    const integritySnapshot = parseWalletRecipientIntegritySnapshot(
        JSON.parse(await readFile(integritySnapshotPath, "utf8")),
    );
    // Bind the mutable staging tree back to the exact hashes embedded by build.rs.
    await verifyWalletRecipientIntegritySnapshot(
        integritySnapshot,
        stagedRuntimeRoot,
    );
    const [appImagePath, debPath] = await Promise.all([
        resolveSingleBundle(bundleRoot, appImageExtension),
        resolveSingleBundle(bundleRoot, debExtension),
    ]);
    const extractionRoot = await mkdtemp(
        path.join(temporaryRoot, "artgod-linux-runtime-"),
    );

    try {
        const appImageExtractionRoot = path.join(extractionRoot, "appimage");
        const debExtractionRoot = path.join(extractionRoot, "deb");
        await Promise.all([
            mkdir(appImageExtractionRoot, { recursive: true }),
            mkdir(debExtractionRoot, { recursive: true }),
        ]);

        await commandRunner(
            appImagePath,
            ["--appimage-extract"],
            appImageExtractionRoot,
        );
        await commandRunner(
            "dpkg-deb",
            ["--extract", debPath, debExtractionRoot],
            extractionRoot,
        );

        const appImageRuntimeRoot = path.join(
            appImageExtractionRoot,
            appImageExtractedDirectoryName,
            "usr",
            linuxSharedResourcesDirectoryName,
            productName,
            "resources",
            "runtime",
        );
        const debRuntimeRoot = path.join(
            debExtractionRoot,
            "usr",
            linuxPrivateResourcesDirectoryName,
            productName,
            "resources",
            "runtime",
        );

        await compareRuntimeTrees(stagedRuntimeRoot, appImageRuntimeRoot);
        await compareRuntimeTrees(stagedRuntimeRoot, debRuntimeRoot);
        await verifyWalletRecipientIntegritySnapshot(
            integritySnapshot,
            appImageRuntimeRoot,
        );
        await verifyWalletRecipientIntegritySnapshot(
            integritySnapshot,
            debRuntimeRoot,
        );
    } finally {
        await rm(extractionRoot, { force: true, recursive: true });
    }

    console.log(
        `Verified staged runtime bytes in ${path.basename(appImagePath)} and ${path.basename(debPath)}.`,
    );
}

// Compares complete runtime trees, including empty directories and regular-file hashes.
export async function compareRuntimeTrees(expectedRoot, actualRoot) {
    const [expectedEntries, actualEntries] = await Promise.all([
        collectRuntimeEntries(expectedRoot),
        collectRuntimeEntries(actualRoot),
    ]);
    const expectedPaths = [...expectedEntries.keys()].sort((a, b) =>
        a.localeCompare(b),
    );
    const actualPaths = [...actualEntries.keys()].sort((a, b) =>
        a.localeCompare(b),
    );

    if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
        const expectedPathSet = new Set(expectedPaths);
        const actualPathSet = new Set(actualPaths);
        const missing = expectedPaths.filter(
            (relativePath) => !actualPathSet.has(relativePath),
        );
        const unexpected = actualPaths.filter(
            (relativePath) => !expectedPathSet.has(relativePath),
        );
        throw new Error(
            `Bundled runtime file set differs from staged resources. Missing: ${formatPaths(missing)}. Unexpected: ${formatPaths(unexpected)}.`,
        );
    }

    for (const relativePath of expectedPaths) {
        const expected = expectedEntries.get(relativePath);
        const actual = actualEntries.get(relativePath);
        if (expected.type !== actual.type) {
            throw new Error(
                `Bundled runtime entry type differs for ${relativePath}: expected ${expected.type}, received ${actual.type}.`,
            );
        }
        if (expected.executableMode !== actual.executableMode) {
            throw new Error(
                `Bundled runtime executable mode differs for ${relativePath}: expected ${formatMode(expected.executableMode)}, received ${formatMode(actual.executableMode)}.`,
            );
        }
        if (expected.type === "file" && expected.sha256 !== actual.sha256) {
            throw new Error(
                `Bundled runtime integrity mismatch: ${relativePath}`,
            );
        }
    }
}

// Verifies one runtime tree against the immutable wallet-recipient snapshot from build.rs.
export async function verifyWalletRecipientIntegritySnapshot(
    snapshot,
    runtimeRoot,
) {
    const expectedFiles = new Map(
        snapshot.files.map((file) => [file.relativePath, file.sha256]),
    );
    const actualFiles = new Map();

    for (const protectedRoot of snapshot.protectedRoots) {
        const protectedEntries = await collectRuntimeEntries(
            path.join(runtimeRoot, protectedRoot),
        );
        for (const [relativePath, entry] of protectedEntries) {
            if (entry.type !== "file") continue;
            actualFiles.set(
                normalizePath(path.join(protectedRoot, relativePath)),
                entry.sha256,
            );
        }
    }

    const expectedPaths = [...expectedFiles.keys()].sort((left, right) =>
        left.localeCompare(right),
    );
    const actualPaths = [...actualFiles.keys()].sort((left, right) =>
        left.localeCompare(right),
    );
    if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) {
        throw new Error(
            "Wallet-recipient runtime file set differs from the build-time integrity snapshot.",
        );
    }
    for (const relativePath of expectedPaths) {
        if (expectedFiles.get(relativePath) !== actualFiles.get(relativePath)) {
            throw new Error(
                `Wallet-recipient runtime differs from the build-time integrity snapshot: ${relativePath}`,
            );
        }
    }
}

// Parses the cross-language snapshot emitted alongside the final Rust executable.
export function parseWalletRecipientIntegritySnapshot(snapshot) {
    if (
        !snapshot ||
        typeof snapshot !== "object" ||
        Array.isArray(snapshot) ||
        snapshot.version !== WALLET_RECIPIENT_INTEGRITY_SNAPSHOT_VERSION ||
        !Array.isArray(snapshot.protectedRoots) ||
        snapshot.protectedRoots.length === 0 ||
        !Array.isArray(snapshot.files) ||
        snapshot.files.length === 0
    ) {
        throw new Error("Invalid wallet-recipient integrity snapshot.");
    }

    const protectedRoots = snapshot.protectedRoots.map((protectedRoot) =>
        validatePortableRelativePath(protectedRoot, "protected root"),
    );
    if (new Set(protectedRoots).size !== protectedRoots.length) {
        throw new Error(
            "Wallet-recipient integrity snapshot contains duplicate protected roots.",
        );
    }
    for (const [index, left] of protectedRoots.entries()) {
        for (const right of protectedRoots.slice(index + 1)) {
            if (left.startsWith(`${right}/`) || right.startsWith(`${left}/`)) {
                throw new Error(
                    "Wallet-recipient integrity snapshot contains overlapping protected roots.",
                );
            }
        }
    }

    const seenPaths = new Set();
    const files = snapshot.files.map((file) => {
        if (!file || typeof file !== "object" || Array.isArray(file)) {
            throw new Error(
                "Wallet-recipient integrity snapshot contains an invalid file.",
            );
        }
        const relativePath = validatePortableRelativePath(
            file.relativePath,
            "file path",
        );
        if (
            !protectedRoots.some(
                (protectedRoot) =>
                    relativePath === protectedRoot ||
                    relativePath.startsWith(`${protectedRoot}/`),
            )
        ) {
            throw new Error(
                `Wallet-recipient integrity snapshot file is outside protected roots: ${relativePath}`,
            );
        }
        if (seenPaths.has(relativePath)) {
            throw new Error(
                `Wallet-recipient integrity snapshot contains a duplicate file: ${relativePath}`,
            );
        }
        if (
            typeof file.sha256 !== "string" ||
            !SHA256_PATTERN.test(file.sha256)
        ) {
            throw new Error(
                `Wallet-recipient integrity snapshot has an invalid SHA-256: ${relativePath}`,
            );
        }
        seenPaths.add(relativePath);
        return Object.freeze({ relativePath, sha256: file.sha256 });
    });

    return Object.freeze({
        protectedRoots: Object.freeze(protectedRoots),
        files: Object.freeze(files),
    });
}

async function collectRuntimeEntries(runtimeRoot) {
    const rootStat = await lstat(runtimeRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new Error(`Runtime root is not a real directory: ${runtimeRoot}`);
    }

    const entries = new Map();
    await collectDirectory(runtimeRoot, runtimeRoot, entries);
    if (entries.size === 0) {
        throw new Error(`Runtime tree is empty: ${runtimeRoot}`);
    }
    return entries;
}

async function collectDirectory(runtimeRoot, directoryPath, entries) {
    const children = await readdir(directoryPath, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));

    for (const child of children) {
        const childPath = path.join(directoryPath, child.name);
        const relativePath = normalizePath(
            path.relative(runtimeRoot, childPath),
        );
        const childStat = await lstat(childPath);
        if (childStat.isSymbolicLink()) {
            throw new Error(
                `Runtime tree contains a symbolic link: ${relativePath}`,
            );
        }
        if (childStat.isDirectory()) {
            entries.set(relativePath, {
                type: "directory",
                executableMode: childStat.mode & EXECUTABLE_MODE_MASK,
            });
            await collectDirectory(runtimeRoot, childPath, entries);
            continue;
        }
        if (childStat.isFile()) {
            entries.set(relativePath, {
                type: "file",
                executableMode: childStat.mode & EXECUTABLE_MODE_MASK,
                sha256: await hashFile(childPath),
            });
            continue;
        }
        throw new Error(
            `Runtime tree contains an unsupported file type: ${relativePath}`,
        );
    }
}

async function resolveSingleBundle(bundleRoot, extension) {
    const matches = [];
    await collectBundleFiles(bundleRoot, extension, matches);
    matches.sort((a, b) => a.localeCompare(b));
    if (matches.length !== 1) {
        throw new Error(
            `Expected exactly one ${extension} bundle under ${bundleRoot}, found ${matches.length}.`,
        );
    }
    return matches[0];
}

async function collectBundleFiles(directoryPath, extension, matches) {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
        const entryPath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
            await collectBundleFiles(entryPath, extension, matches);
        } else if (entry.isFile() && entry.name.endsWith(extension)) {
            matches.push(entryPath);
        }
    }
}

async function hashFile(filePath) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filePath)) {
        hash.update(chunk);
    }
    return hash.digest("hex");
}

async function runCommand(command, args, cwd) {
    await new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            env: process.env,
            stdio: "inherit",
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(
                new Error(
                    `${command} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}.`,
                ),
            );
        });
    });
}

function normalizePath(filePath) {
    return filePath.split(path.sep).join("/");
}

function validatePortableRelativePath(value, description) {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.includes("\\") ||
        path.posix.isAbsolute(value) ||
        value
            .split("/")
            .some(
                (component) =>
                    !component || component === "." || component === "..",
            )
    ) {
        throw new Error(
            `Wallet-recipient integrity snapshot has an invalid ${description}.`,
        );
    }
    return value;
}

function formatMode(mode) {
    return `0${mode.toString(8).padStart(3, "0")}`;
}

function formatPaths(paths) {
    return paths.length === 0 ? "none" : paths.join(", ");
}

async function main() {
    const bundleRoot = process.argv[2]
        ? path.resolve(process.argv[2])
        : path.join(
              rootDir,
              "src-tauri",
              "target",
              "x86_64-unknown-linux-gnu",
              "release",
              "bundle",
          );
    const tauriConfig = JSON.parse(
        await readFile(
            path.join(rootDir, "src-tauri", "tauri.conf.json"),
            "utf8",
        ),
    );
    const productName = tauriConfig.productName?.trim();
    if (!productName) {
        throw new Error("src-tauri/tauri.conf.json has no productName.");
    }

    await verifyLinuxBundledRuntime({
        bundleRoot,
        stagedRuntimeRoot: path.join(
            rootDir,
            "src-tauri",
            "resources",
            "runtime",
        ),
        integritySnapshotPath: path.join(
            path.dirname(bundleRoot),
            WALLET_RECIPIENT_INTEGRITY_SNAPSHOT_FILE_NAME,
        ),
        productName,
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    await main();
}
