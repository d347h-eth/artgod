#!/usr/bin/env node
import { access, cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    assertNoForbiddenDesktopRuntimePaths,
    stageDesktopRuntimeDependencies,
} from "./desktop-runtime-dependency-staging.mjs";
import {
    DESKTOP_RUNTIME_INPUT,
    readDesktopRuntimeInputs,
    resolveDesktopRuntimeInputContext,
    stageDesktopRuntimeExecutables,
} from "./desktop-runtime-inputs.mjs";
import { verifyStagedDesktopRuntimeDependencies } from "./verify-staged-desktop-runtime-dependencies.mjs";
import { verifyStagedDesktopNatsLoopbackBinding } from "./verify-staged-desktop-nats-loopback.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");
const inputs = await readDesktopRuntimeInputs({ rootDir });
const context = resolveDesktopRuntimeInputContext(inputs);
const nodeDistTarget = context.target;

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
        source: path.join(rootDir, "frontend", "dist-userland"),
        target: path.join(resourcesRootDir, "frontend", "userland"),
        description: "userland frontend static artifacts",
    },
    {
        source: path.join(rootDir, "indexer", "dist-desktop"),
        target: path.join(resourcesRootDir, "indexer", "dist-desktop"),
        description: "indexer runtime artifacts",
    },
    {
        source: path.join(rootDir, "trading", "dist-desktop"),
        target: path.join(resourcesRootDir, "trading", "dist-desktop"),
        description: "trading runtime artifacts",
    },
    {
        source: path.join(rootDir, "database", "migrations"),
        target: path.join(resourcesRootDir, "database", "migrations"),
        description: "database migrations",
    },
];

await rm(resourcesRootDir, { recursive: true, force: true });
await mkdir(resourcesRootDir, { recursive: true });

for (const spec of copySpecs) {
    await assertExists(spec.source, spec.description);
    await mkdir(path.dirname(spec.target), { recursive: true });
    await cp(spec.source, spec.target, { recursive: true });
}

// Materialize only the reviewed package closures beside their runtime artifacts.
await assertNoForbiddenDesktopRuntimePaths(resourcesRootDir);
await stageDesktopRuntimeDependencies({
    rootDir,
    destinationRootDir: resourcesRootDir,
    nodeTarget: nodeDistTarget,
});

const binaries = await stageDesktopRuntimeExecutables({
    rootDir,
    resourcesRootDir,
    context,
});
const bundledNodeBinaryPath = binaries[DESKTOP_RUNTIME_INPUT.Node];
const bundledNatsBinaryPath = binaries[DESKTOP_RUNTIME_INPUT.Nats];
// Prove the bundled Node can load and execute every staged native dependency.
await verifyStagedDesktopRuntimeDependencies({
    resourcesRootDir,
    nodeBinaryPath: bundledNodeBinaryPath,
});
// Prove the bundled NATS reports and serves the numeric IPv4 loopback listener.
await verifyStagedDesktopNatsLoopbackBinding({
    natsBinaryPath: bundledNatsBinaryPath,
});

// Keep runtime resources directory tracked in git between clean/build cycles.
await writeFile(path.join(resourcesRootDir, ".gitkeep"), "", "utf8");

console.log(
    `Prepared desktop runtime resources at ${path.relative(rootDir, resourcesRootDir)} (node ${inputs.node.version}, node target ${context.target}, nats ${inputs.nats.version}, nats target ${context.target})`,
);

async function assertExists(targetPath, description) {
    try {
        await access(targetPath);
    } catch {
        throw new Error(
            `Missing ${description}: ${path.relative(rootDir, targetPath)}. Run \`yarn install --immutable\` and then \`yarn build:desktop-runtime\`.`,
        );
    }
}
