#!/usr/bin/env node
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");

const MODE_SIGN_STAGED = "sign-staged";
const MODE_VERIFY_APP = "verify-app";
const MODE_VERIFY_DMG = "verify-dmg";
const appleSigningIdentityEnvKey = "APPLE_SIGNING_IDENTITY";
const bundledNodeRelativeSuffix = "/runtime/node/node";
const bundledNatsRelativeSuffix = "/runtime/nats/nats-server";
const secretPromptBinaryNamePrefix = "artgod-secret-prompt";
const appBundleExtension = ".app";
const dmgBundleExtension = ".dmg";
const stagedMacOSBinaryRoots = [
    path.join(rootDir, "src-tauri", "resources", "runtime"),
    path.join(rootDir, "src-tauri", "binaries"),
];
const defaultMacOSBundleRoot = path.join(
    rootDir,
    "src-tauri",
    "target",
    "universal-apple-darwin",
    "release",
    "bundle",
    "macos",
);
const defaultMacOSDmgBundleRoot = path.join(
    rootDir,
    "src-tauri",
    "target",
    "universal-apple-darwin",
    "release",
    "bundle",
    "dmg",
);
const requiredBundleExecutables = [
    {
        label: "bundled Node runtime",
        matches: (relativePath) =>
            relativePath.endsWith(bundledNodeRelativeSuffix),
    },
    {
        label: "bundled NATS runtime",
        matches: (relativePath) =>
            relativePath.endsWith(bundledNatsRelativeSuffix),
    },
    {
        label: "secret prompt sidecar",
        matches: (relativePath) =>
            path
                .basename(relativePath)
                .startsWith(secretPromptBinaryNamePrefix),
    },
];

const mode = process.argv[2];

if (mode === MODE_SIGN_STAGED) {
    await signStagedMacOSBinaries();
} else if (mode === MODE_VERIFY_APP) {
    await verifyMacOSAppBundle();
} else if (mode === MODE_VERIFY_DMG) {
    await verifyMacOSDmgBundle();
} else {
    throw new Error(
        `Usage: node scripts/build/macos-code-signing.mjs ${MODE_SIGN_STAGED}|${MODE_VERIFY_APP}|${MODE_VERIFY_DMG} [app-or-bundle-root|dmg-or-bundle-root]`,
    );
}

async function signStagedMacOSBinaries() {
    if (!isMacOSBuildTarget()) {
        console.log(
            "Skipping macOS binary signing for non-macOS build target.",
        );
        return;
    }
    assertMacOSHost("Signing macOS binaries");

    const signingIdentity = process.env[appleSigningIdentityEnvKey]?.trim();
    if (!signingIdentity) {
        console.log(
            `Skipping staged macOS binary signing because ${appleSigningIdentityEnvKey} is not set.`,
        );
        return;
    }

    const machOFiles = await collectSignableMachOFiles(stagedMacOSBinaryRoots);
    if (machOFiles.length === 0) {
        throw new Error(
            "No signable Mach-O binaries found in staged macOS runtime resources or sidecars.",
        );
    }

    for (const filePath of sortNestedFirst(machOFiles)) {
        const relativePath = path.relative(rootDir, filePath);
        console.log(`Signing macOS binary: ${relativePath}`);
        await runCommand("codesign", [
            "--force",
            "--options",
            "runtime",
            "--timestamp",
            "--sign",
            signingIdentity,
            filePath,
        ]);
        await verifyCodeSignature(filePath);
    }
}

async function verifyMacOSAppBundle() {
    assertMacOSHost("Verifying macOS app signatures");

    await verifyMacOSAppBundleAtPath(
        process.argv[3]
            ? path.resolve(process.argv[3])
            : defaultMacOSBundleRoot,
    );
}

async function verifyMacOSDmgBundle() {
    assertMacOSHost("Verifying macOS DMG app signatures");

    const dmgPath = await resolveDmgBundlePath(
        process.argv[3]
            ? path.resolve(process.argv[3])
            : defaultMacOSDmgBundleRoot,
    );
    const mountRoot = await mkdtemp(
        path.join(resolveTemporaryDirectory(), "artgod-dmg-"),
    );

    let attached = false;
    try {
        await runCommand("hdiutil", [
            "attach",
            dmgPath,
            "-readonly",
            "-nobrowse",
            "-mountpoint",
            mountRoot,
        ]);
        attached = true;

        await verifyMacOSAppBundleAtPath(mountRoot);
    } finally {
        if (attached) {
            await runCommand("hdiutil", ["detach", mountRoot]);
        }
        await rm(mountRoot, { force: true, recursive: true });
    }
}

async function verifyMacOSAppBundleAtPath(inputPath) {
    const appPath = await resolveAppBundlePath(inputPath);
    const machOFiles = await collectSignableMachOFiles([appPath]);
    if (machOFiles.length === 0) {
        throw new Error(`No signable Mach-O binaries found inside ${appPath}`);
    }

    assertRequiredBundleExecutables(appPath, machOFiles);

    for (const filePath of sortNestedFirst(machOFiles)) {
        await verifyCodeSignature(filePath);
    }

    await runCommand("codesign", [
        "--verify",
        "--deep",
        "--strict",
        "--verbose=2",
        appPath,
    ]);

    console.log(
        `Verified ${machOFiles.length} signed Mach-O file(s) inside ${path.relative(rootDir, appPath)}.`,
    );
}

function resolveTemporaryDirectory() {
    return process.env.RUNNER_TEMP?.trim() || os.tmpdir();
}

function isMacOSBuildTarget() {
    const explicitTarget = [
        process.env.TAURI_ENV_TARGET_TRIPLE,
        process.env.CARGO_BUILD_TARGET,
        process.env.TARGET,
    ]
        .map((value) => value?.trim())
        .find(Boolean);
    if (explicitTarget) {
        return explicitTarget.includes("apple-darwin");
    }

    const tauriPlatform = process.env.TAURI_ENV_PLATFORM?.trim().toLowerCase();
    if (tauriPlatform) {
        return tauriPlatform === "darwin" || tauriPlatform === "macos";
    }

    return process.platform === "darwin";
}

function assertMacOSHost(action) {
    if (process.platform !== "darwin") {
        throw new Error(`${action} requires a macOS runner.`);
    }
}

async function collectSignableMachOFiles(rootPaths) {
    const files = [];
    for (const rootPath of rootPaths) {
        files.push(...(await collectFiles(rootPath)));
    }

    const machOFiles = [];
    for (const filePath of files) {
        const { stdout } = await runCommand("file", ["-b", filePath], {
            capture: true,
        });
        if (isSignableMachO(stdout)) {
            machOFiles.push(filePath);
        }
    }
    return machOFiles.sort((a, b) => a.localeCompare(b));
}

function isSignableMachO(fileDescription) {
    if (!fileDescription.includes("Mach-O")) {
        return false;
    }
    return (
        fileDescription.includes("executable") ||
        fileDescription.includes("dynamically linked shared library") ||
        fileDescription.includes("bundle")
    );
}

async function collectFiles(rootPath) {
    const result = [];
    const rootStat = await lstat(rootPath);
    if (rootStat.isSymbolicLink()) {
        return result;
    }
    if (rootStat.isFile()) {
        return [rootPath];
    }
    if (!rootStat.isDirectory()) {
        return result;
    }

    const entries = await readdir(rootPath, { withFileTypes: true });
    for (const entry of entries) {
        const entryPath = path.join(rootPath, entry.name);
        if (entry.isSymbolicLink()) {
            continue;
        }
        if (entry.isDirectory()) {
            result.push(...(await collectFiles(entryPath)));
            continue;
        }
        if (entry.isFile()) {
            result.push(entryPath);
        }
    }
    return result;
}

async function resolveAppBundlePath(inputPath) {
    if (inputPath.endsWith(appBundleExtension)) {
        return inputPath;
    }

    return await resolveSingleBundlePath(
        inputPath,
        appBundleExtension,
        (entry) => entry.isDirectory(),
    );
}

async function resolveDmgBundlePath(inputPath) {
    if (inputPath.endsWith(dmgBundleExtension)) {
        return inputPath;
    }

    return await resolveSingleBundlePath(
        inputPath,
        dmgBundleExtension,
        (entry) => entry.isFile(),
    );
}

async function resolveSingleBundlePath(inputPath, extension, matchesEntry) {
    const entries = await readdir(inputPath, { withFileTypes: true });
    const bundles = entries
        .filter(
            (entry) =>
                matchesEntry(entry) && entry.name.endsWith(extension),
        )
        .map((entry) => path.join(inputPath, entry.name))
        .sort((a, b) => a.localeCompare(b));

    if (bundles.length !== 1) {
        throw new Error(
            `Expected exactly one ${extension} bundle under ${inputPath}, found ${bundles.length}.`,
        );
    }

    return bundles[0];
}

function assertRequiredBundleExecutables(appPath, machOFiles) {
    const relativePaths = machOFiles.map((filePath) =>
        normalizePath(path.relative(appPath, filePath)),
    );

    for (const required of requiredBundleExecutables) {
        const match = relativePaths.find(required.matches);
        if (!match) {
            throw new Error(
                `Missing required signed executable in macOS app bundle: ${required.label}`,
            );
        }
    }
}

async function verifyCodeSignature(filePath) {
    await runCommand("codesign", [
        "--verify",
        "--strict",
        "--verbose=2",
        filePath,
    ]);
}

function sortNestedFirst(filePaths) {
    return [...filePaths].sort((left, right) => {
        const rightDepth = right.split(path.sep).length;
        const leftDepth = left.split(path.sep).length;
        if (rightDepth !== leftDepth) {
            return rightDepth - leftDepth;
        }
        return left.localeCompare(right);
    });
}

function normalizePath(filePath) {
    return filePath.split(path.sep).join("/");
}

async function runCommand(command, args, options = {}) {
    const capture = options.capture === true;
    return await new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: rootDir,
            env: process.env,
            stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
        });

        let stdout = "";
        let stderr = "";
        if (capture) {
            child.stdout?.on("data", (chunk) => {
                stdout += chunk.toString();
            });
            child.stderr?.on("data", (chunk) => {
                stderr += chunk.toString();
            });
        }

        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0) {
                resolve({ stdout, stderr });
                return;
            }
            reject(
                new Error(
                    `${command} ${args.join(" ")} failed with exit code ${code}${
                        stderr ? `\n${stderr}` : ""
                    }`,
                ),
            );
        });
    });
}
