#!/usr/bin/env node
import { chmod, copyFile, mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");
const srcTauriDir = path.join(rootDir, "src-tauri");
const helperManifestPath = path.join(
    srcTauriDir,
    "sidecars",
    "artgod-secret-prompt",
    "Cargo.toml",
);
const targetDir = path.join(srcTauriDir, "target", "sidecars");
const binariesDir = path.join(srcTauriDir, "binaries");
const profile = resolveProfile(process.argv.slice(2));
const targetSpec = await resolveTargetSpec();
const isWindowsTarget = targetSpec.requestedTarget.includes("windows");
const binaryExtension = isWindowsTarget ? ".exe" : "";
const helperBinaryName = `artgod-secret-prompt${binaryExtension}`;

await ensureExists(helperManifestPath, "secret prompt helper Cargo manifest");
await mkdir(binariesDir, { recursive: true });

const builtBinaries = [];
const stagedBinaryPaths = [];
for (const buildTarget of targetSpec.buildTargets) {
    const builtBinaryPath = await buildSidecarTarget(
        buildTarget,
        profile,
        helperBinaryName,
    );
    builtBinaries.push({ target: buildTarget, path: builtBinaryPath });
    stagedBinaryPaths.push(
        await stageBuiltSidecar(buildTarget, builtBinaryPath, binaryExtension),
    );
}

if (targetSpec.universalTarget) {
    // Build a fat sidecar for Tauri universal macOS bundles.
    stagedBinaryPaths.push(
        await stageUniversalSidecar(
            targetSpec.universalTarget,
            builtBinaries.map((binary) => binary.path),
            binaryExtension,
        ),
    );
}

console.log(
    `Prepared desktop sidecars ${stagedBinaryPaths
        .map((stagedPath) => path.relative(rootDir, stagedPath))
        .join(", ")} (${profile}, ${targetSpec.requestedTarget})`,
);

function resolveProfile(argv) {
    const profileFlagIndex = argv.findIndex((arg) => arg === "--profile");
    if (profileFlagIndex >= 0) {
        const rawProfile = argv[profileFlagIndex + 1]?.trim();
        if (rawProfile === "debug" || rawProfile === "release") {
            return rawProfile;
        }
    }
    return "release";
}

async function resolveTargetSpec() {
    const configuredTarget =
        process.env.CARGO_BUILD_TARGET?.trim() ||
        process.env.TAURI_ENV_TARGET_TRIPLE?.trim();
    if (configuredTarget === "universal-apple-darwin") {
        return {
            requestedTarget: configuredTarget,
            buildTargets: ["aarch64-apple-darwin", "x86_64-apple-darwin"],
            universalTarget: configuredTarget,
        };
    }
    if (configuredTarget) {
        return {
            requestedTarget: configuredTarget,
            buildTargets: [configuredTarget],
            universalTarget: null,
        };
    }
    const { stdout } = await runCommand("rustc", ["--print", "host-tuple"], {
        cwd: rootDir,
        capture: true,
    });
    const target = stdout.trim();
    if (!target) {
        throw new Error("Failed to determine Rust target triple for secret prompt sidecar");
    }
    return {
        requestedTarget: target,
        buildTargets: [target],
        universalTarget: null,
    };
}

async function buildSidecarTarget(targetTriple, profile, helperBinaryName) {
    const cargoArgs = [
        "build",
        "--manifest-path",
        helperManifestPath,
        "--target-dir",
        targetDir,
        "--target",
        targetTriple,
    ];
    if (profile === "release") {
        cargoArgs.push("--release");
    }

    await runCommand("cargo", cargoArgs, { cwd: rootDir });

    const builtBinaryPath = path.join(
        targetDir,
        targetTriple,
        profile,
        helperBinaryName,
    );
    await ensureExists(builtBinaryPath, "built secret prompt helper binary");
    return builtBinaryPath;
}

async function stageBuiltSidecar(targetTriple, builtBinaryPath, binaryExtension) {
    const stagedBinaryPath = resolveStagedBinaryPath(targetTriple, binaryExtension);
    await copyFile(builtBinaryPath, stagedBinaryPath);
    if (!targetTriple.includes("windows")) {
        await chmod(stagedBinaryPath, 0o755);
    }
    return stagedBinaryPath;
}

async function stageUniversalSidecar(targetTriple, builtBinaryPaths, binaryExtension) {
    const stagedBinaryPath = resolveStagedBinaryPath(targetTriple, binaryExtension);
    await runCommand(
        "lipo",
        ["-create", ...builtBinaryPaths, "-output", stagedBinaryPath],
        { cwd: rootDir },
    );
    await chmod(stagedBinaryPath, 0o755);
    return stagedBinaryPath;
}

function resolveStagedBinaryPath(targetTriple, binaryExtension) {
    return path.join(
        binariesDir,
        `artgod-secret-prompt-${targetTriple}${binaryExtension}`,
    );
}

async function ensureExists(filePath, description) {
    try {
        await readFile(filePath);
    } catch {
        throw new Error(
            `Missing ${description}: ${path.relative(rootDir, filePath)}`,
        );
    }
}

async function runCommand(command, args, options) {
    const capture = options?.capture === true;
    return await new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options?.cwd ?? rootDir,
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
