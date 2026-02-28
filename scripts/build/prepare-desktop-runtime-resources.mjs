#!/usr/bin/env node
import { access, cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");

const resourcesRootDir = path.join(
    rootDir,
    "src-tauri",
    "resources",
    "runtime",
);

const copySpecs = [
    {
        source: path.join(rootDir, "backend", "dist-desktop"),
        target: path.join(resourcesRootDir, "backend", "dist-desktop"),
        description: "backend runtime artifacts",
    },
    {
        source: path.join(rootDir, "indexer", "dist-desktop"),
        target: path.join(resourcesRootDir, "indexer", "dist-desktop"),
        description: "indexer runtime artifacts",
    },
    {
        source: path.join(rootDir, "database", "migrations"),
        target: path.join(resourcesRootDir, "database", "migrations"),
        description: "database migrations",
    },
    {
        source: path.join(rootDir, ".pnp.cjs"),
        target: path.join(resourcesRootDir, ".pnp.cjs"),
        description: "Yarn PnP runtime hook (.pnp.cjs)",
    },
    {
        source: path.join(rootDir, ".pnp.loader.mjs"),
        target: path.join(resourcesRootDir, ".pnp.loader.mjs"),
        description: "Yarn PnP runtime hook (.pnp.loader.mjs)",
    },
    {
        source: path.join(rootDir, ".yarn", "cache"),
        target: path.join(resourcesRootDir, ".yarn", "cache"),
        description: "Yarn local package cache",
    },
    {
        source: path.join(rootDir, ".yarn", "unplugged"),
        target: path.join(resourcesRootDir, ".yarn", "unplugged"),
        description: "Yarn unplugged native/runtime packages",
    },
    {
        source: path.join(rootDir, ".yarn", "install-state.gz"),
        target: path.join(resourcesRootDir, ".yarn", "install-state.gz"),
        description: "Yarn install state",
    },
    {
        source: path.join(
            rootDir,
            "indexer",
            "tests",
            "fixtures",
            "opensea-event-payloads",
        ),
        target: path.join(
            resourcesRootDir,
            "indexer",
            "tests",
            "fixtures",
            "opensea-event-payloads",
        ),
        description: "OpenSea fixture payloads",
    },
];

await rm(resourcesRootDir, { recursive: true, force: true });
await mkdir(resourcesRootDir, { recursive: true });

for (const spec of copySpecs) {
    await assertExists(spec.source, spec.description);
    await mkdir(path.dirname(spec.target), { recursive: true });
    await cp(spec.source, spec.target, { recursive: true });
}

// Keep runtime resources directory tracked in git between clean/build cycles.
await writeFile(path.join(resourcesRootDir, ".gitkeep"), "", "utf8");

console.log(
    `Prepared desktop runtime resources at ${path.relative(rootDir, resourcesRootDir)}`,
);

async function assertExists(targetPath, description) {
    try {
        await access(targetPath);
    } catch {
        throw new Error(
            `Missing ${description}: ${path.relative(rootDir, targetPath)}. Run \`yarn build:runtime\` and ensure Yarn PnP files exist.`,
        );
    }
}
