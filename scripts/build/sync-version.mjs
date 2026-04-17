#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");

const rootPackageJsonPath = path.join(rootDir, "package.json");
const rootPackageJson = JSON.parse(await readFile(rootPackageJsonPath, "utf8"));
const rootVersion = String(rootPackageJson.version ?? "").trim();

if (!rootVersion) {
    throw new Error("Root package.json version is missing");
}

for (const relativePath of [
    "backend/package.json",
    "database/package.json",
    "frontend/package.json",
    "indexer/package.json",
    "shared/package.json",
    "trading/package.json",
]) {
    const targetPath = path.join(rootDir, relativePath);
    const packageJson = JSON.parse(await readFile(targetPath, "utf8"));
    packageJson.version = rootVersion;
    await writeJson(targetPath, packageJson);
}

await updateJsonFile("src-tauri/tauri.conf.json", (config) => {
    config.version = rootVersion;
    return config;
});

await updateTextFile("src-tauri/Cargo.toml", (source) =>
    source.replace(/^version = ".*"$/m, `version = "${rootVersion}"`),
);

await updateTextFile("src-tauri/Cargo.lock", (source) =>
    source.replace(
        /name = "artgod-desktop"\nversion = ".*"/m,
        `name = "artgod-desktop"\nversion = "${rootVersion}"`,
    ),
);

await updateTextFile("docs/backend-api.openapi.yaml", (source) =>
    source.replace(/^    version: .*$/m, `    version: ${rootVersion}`),
);

console.log(`Synchronized project version to ${rootVersion}`);

async function updateJsonFile(relativePath, mutate) {
    const targetPath = path.join(rootDir, relativePath);
    const json = JSON.parse(await readFile(targetPath, "utf8"));
    const updated = mutate(json);
    await writeJson(targetPath, updated);
}

async function writeJson(targetPath, value) {
    await writeFile(targetPath, `${JSON.stringify(value, null, 4)}\n`);
}

async function updateTextFile(relativePath, mutate) {
    const targetPath = path.join(rootDir, relativePath);
    const source = await readFile(targetPath, "utf8");
    const updated = mutate(source);
    if (updated === source) {
        throw new Error(`Expected version marker not found in ${relativePath}`);
    }
    await writeFile(targetPath, updated);
}
