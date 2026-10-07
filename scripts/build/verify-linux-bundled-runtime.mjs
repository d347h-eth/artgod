#!/usr/bin/env node
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyAppImageHostLibraries } from "./linux-appimage-host-libraries.mjs";
import {
    WALLET_RECIPIENT_INTEGRITY_SNAPSHOT_FILE_NAME,
    collectRuntimeEntries,
    readWalletRecipientIntegritySnapshot,
    verifyWalletRecipientIntegritySnapshot,
} from "./wallet-recipient-integrity-snapshot.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(scriptPath), "../..");
const appImageExtension = ".AppImage";
const debExtension = ".deb";
const linuxBundleExtensions = [appImageExtension, debExtension];
const appImageExtractedDirectoryName = "squashfs-root";
const linuxSharedResourcesDirectoryName = "share";
const linuxPrivateResourcesDirectoryName = "lib";
const maximumCapturedCommandOutputBytes = 1024;

// Verifies that Linux packaging preserved every staged runtime byte and file type.
export async function verifyLinuxBundledRuntime({
    bundleRoot,
    stagedRuntimeRoot,
    integritySnapshotPath,
    productName,
    commandRunner = runCommand,
    temporaryRoot = os.tmpdir(),
}) {
    const integritySnapshot = await readWalletRecipientIntegritySnapshot(
        integritySnapshotPath,
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

        const offsetOutput = await commandRunner(
            appImagePath,
            ["--appimage-offset"],
            appImageExtractionRoot,
            { captureStdout: true },
        );
        const filesystemOffset = offsetOutput?.trim();
        if (
            !/^[1-9][0-9]*$/.test(filesystemOffset) ||
            !Number.isSafeInteger(Number(filesystemOffset))
        ) {
            throw new Error("Invalid AppImage filesystem offset.");
        }
        // The AppImage runtime creates extracted directories as 0700. Unsquashfs
        // preserves their stored modes, which this verifier must compare exactly.
        await commandRunner(
            "unsquashfs",
            [
                "-no-progress",
                // Integrity checks cover bytes and modes, not host security labels.
                "-no-xattrs",
                "-d",
                path.join(
                    appImageExtractionRoot,
                    appImageExtractedDirectoryName,
                ),
                "-o",
                filesystemOffset,
                appImagePath,
            ],
            appImageExtractionRoot,
        );
        await commandRunner(
            "dpkg-deb",
            ["--extract", debPath, debExtractionRoot],
            extractionRoot,
        );

        const appDir = path.join(
            appImageExtractionRoot,
            appImageExtractedDirectoryName,
        );
        await verifyAppImageHostLibraries(appDir);
        const appImageRuntimeRoot = path.join(
            appDir,
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

async function resolveSingleBundle(bundleRoot, extension) {
    const matches = (await listLinuxBundleFiles(bundleRoot)).filter(
        (filePath) => filePath.endsWith(extension),
    );
    if (matches.length !== 1) {
        throw new Error(
            `Expected exactly one ${extension} bundle under ${bundleRoot}, found ${matches.length}.`,
        );
    }
    return matches[0];
}

// Discovery also serves failed-build artifact collection. It returns only real
// package files; verification separately requires one of each declared format.
export async function listLinuxBundleFiles(bundleRoot) {
    const matches = [];
    await collectBundleFiles(bundleRoot, matches);
    return matches.sort((a, b) => a.localeCompare(b));
}

async function collectBundleFiles(directoryPath, matches) {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
        const entryPath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
            await collectBundleFiles(entryPath, matches);
        } else if (
            entry.isFile() &&
            linuxBundleExtensions.some((extension) =>
                entry.name.endsWith(extension),
            )
        ) {
            matches.push(entryPath);
        }
    }
}

async function runCommand(command, args, cwd, { captureStdout = false } = {}) {
    return await new Promise((resolve, reject) => {
        const outputChunks = [];
        let outputBytes = 0;
        const child = spawn(command, args, {
            cwd,
            env: process.env,
            stdio: captureStdout ? ["ignore", "pipe", "inherit"] : "inherit",
        });
        if (captureStdout) {
            child.stdout.on("data", (chunk) => {
                outputBytes += chunk.length;
                if (outputBytes > maximumCapturedCommandOutputBytes) {
                    child.kill();
                    reject(new Error(`${command} returned too much output.`));
                    return;
                }
                outputChunks.push(chunk);
            });
        }
        child.once("error", reject);
        child.once("close", (code, signal) => {
            if (code === 0) {
                resolve(Buffer.concat(outputChunks).toString("utf8"));
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
