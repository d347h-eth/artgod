#!/usr/bin/env node
import { access, cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { assertNoForbiddenDesktopRuntimePaths } from "./desktop-runtime-dependency-staging.mjs";
import {
    DESKTOP_RUNTIME_INPUT,
    readDesktopRuntimeInputs,
    resolveDesktopRuntimeInputContext,
    stageDesktopRuntimeExecutables,
} from "./desktop-runtime-inputs.mjs";
import { stageLocalDesktopDependencies } from "./local-desktop-dependencies.mjs";
import { localDesktopPaths, projectRoot } from "./local-desktop-contract.mjs";
import { verifyLocalDesktopObservabilityDependencies } from "./verify-local-desktop-observability.mjs";
import { verifyStagedDesktopRuntimeDependencies } from "./verify-staged-desktop-runtime-dependencies.mjs";
import { verifyStagedDesktopNatsLoopbackBinding } from "./verify-staged-desktop-nats-loopback.mjs";

const rootDir = projectRoot;
const inputs = await readDesktopRuntimeInputs({ rootDir });
const context = resolveDesktopRuntimeInputContext(inputs);
// Native profiler selection uses the ABI of the canonical Node build host.
if (process.versions.node !== inputs.node.version) {
    throw new Error(
        `Local desktop staging requires Node ${inputs.node.version}; current Node is ${process.versions.node}.`,
    );
}
const { resources: resourcesRootDir, artifacts } = localDesktopPaths(rootDir);
const copySpecs = [
    {
        source: path.join(artifacts, "backend"),
        target: path.join(resourcesRootDir, "backend", "dist-desktop"),
        description: "backend runtime artifacts",
    },
    {
        source: path.join(rootDir, "frontend", "dist-userland"),
        target: path.join(resourcesRootDir, "frontend", "userland"),
        description: "userland frontend static artifacts",
    },
    {
        source: path.join(artifacts, "indexer"),
        target: path.join(resourcesRootDir, "indexer", "dist-desktop"),
        description: "indexer runtime artifacts",
    },
    {
        source: path.join(artifacts, "trading"),
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

// Keep profile admission and dependency selection exclusive to the local path.
await assertNoForbiddenDesktopRuntimePaths(resourcesRootDir);
await stageLocalDesktopDependencies({
    rootDir,
    destinationRootDir: resourcesRootDir,
    nodeTarget: context.target,
    nodeAbi: process.versions.modules,
});
// Reuse reviewed archive acquisition; production staging never runs here.
const binaries = await stageDesktopRuntimeExecutables({
    rootDir,
    resourcesRootDir,
    context,
});
const nodeBinaryPath = binaries[DESKTOP_RUNTIME_INPUT.Node];
await verifyStagedDesktopRuntimeDependencies({
    resourcesRootDir,
    nodeBinaryPath,
});
await verifyLocalDesktopObservabilityDependencies({
    resourcesRootDir,
    nodeBinaryPath,
});
await verifyStagedDesktopNatsLoopbackBinding({
    natsBinaryPath: binaries[DESKTOP_RUNTIME_INPUT.Nats],
});
console.log(
    `Prepared local desktop runtime resources at ${path.relative(rootDir, resourcesRootDir)} (node ${inputs.node.version}, nats ${inputs.nats.version}, target ${context.target})`,
);

async function assertExists(targetPath, description) {
    try {
        await access(targetPath);
    } catch {
        throw new Error(
            `Missing ${description}: ${path.relative(rootDir, targetPath)}. Run yarn install --immutable and then yarn build:desktop:local.`,
        );
    }
}
