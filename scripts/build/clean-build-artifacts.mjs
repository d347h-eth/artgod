#!/usr/bin/env node
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");

const rootPackageJsonPath = path.join(rootDir, "package.json");
const rootPackageJson = JSON.parse(await readFile(rootPackageJsonPath, "utf8"));
const workspaces = Array.isArray(rootPackageJson.workspaces)
    ? rootPackageJson.workspaces
    : [];

const cacheDirs = [
    "dist",
    "dist-desktop",
    "dist-userland",
    "build-web",
    ".vite",
    ".vitest",
    ".svelte-kit",
];
const candidatePaths = new Set();

for (const dir of cacheDirs) {
    candidatePaths.add(path.join(rootDir, dir));
    candidatePaths.add(path.join(rootDir, "node_modules", dir));
}

for (const workspace of workspaces) {
    const workspaceRoot = path.join(rootDir, workspace);
    for (const dir of cacheDirs) {
        candidatePaths.add(path.join(workspaceRoot, dir));
    }
    candidatePaths.add(path.join(workspaceRoot, "node_modules", ".vite"));
}

// Rust/Tauri build output cache.
candidatePaths.add(path.join(rootDir, "src-tauri", "target"));
candidatePaths.add(path.join(rootDir, "src-tauri", "binaries"));
candidatePaths.add(
    path.join(
        rootDir,
        "src-tauri",
        "crates",
        "artgod-secret-prompt-protocol",
        "target",
    ),
);
candidatePaths.add(
    path.join(
        rootDir,
        "src-tauri",
        "sidecars",
        "artgod-secret-prompt",
        "target",
    ),
);
candidatePaths.add(path.join(rootDir, "src-tauri", "resources", "runtime"));
candidatePaths.add(path.join(rootDir, ".cache", "desktop-node-runtime"));
candidatePaths.add(path.join(rootDir, ".cache", "desktop-nats-runtime"));

const removed = [];

for (const targetPath of candidatePaths) {
    if (await pathExists(targetPath)) {
        await rm(targetPath, { recursive: true, force: true });
        removed.push(path.relative(rootDir, targetPath) || ".");
    }
}

const runtimeResourcesDir = path.join(
    rootDir,
    "src-tauri",
    "resources",
    "runtime",
);
const sidecarBinariesDir = path.join(rootDir, "src-tauri", "binaries");
await mkdir(runtimeResourcesDir, { recursive: true });
await writeFile(path.join(runtimeResourcesDir, ".gitkeep"), "", "utf8");
await mkdir(sidecarBinariesDir, { recursive: true });
await writeFile(path.join(sidecarBinariesDir, ".gitkeep"), "", "utf8");

if (removed.length === 0) {
    console.log("No build artifacts found to remove.");
    process.exit(0);
}

console.log("Removed build artifacts:");
for (const entry of removed.sort((a, b) => a.localeCompare(b))) {
    console.log(`- ${entry}`);
}

async function pathExists(targetPath) {
    try {
        await access(targetPath);
        return true;
    } catch {
        return false;
    }
}
