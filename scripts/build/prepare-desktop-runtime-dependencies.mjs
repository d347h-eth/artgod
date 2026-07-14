#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stageDesktopRuntimeDependencies } from "./desktop-runtime-dependency-staging.mjs";
import {
    DESKTOP_BUILD_TARGET_ENV_KEYS,
    resolveDesktopDistributionTargetFromEnvironment,
} from "./native-runtime-dependencies.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");
const nodeTarget = resolveDesktopDistributionTargetFromEnvironment({
    distributionTargetEnvKey:
        DESKTOP_BUILD_TARGET_ENV_KEYS.NodeDistributionTarget,
});

// Prepare package-local dependencies for built artifacts without downloading desktop binaries.
await stageDesktopRuntimeDependencies({
    rootDir,
    destinationRootDir: rootDir,
    nodeTarget,
});

console.log(
    `Prepared isolated desktop runtime dependencies for target ${nodeTarget}.`,
);
