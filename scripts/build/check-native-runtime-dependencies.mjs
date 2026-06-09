#!/usr/bin/env node
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES } from "./native-runtime-dependencies.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");

const nativeRuntimeDependencyChecks = [
    {
        packageName: NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.BetterSqlite3,
        issuerPath: path.join(rootDir, "package.json"),
        verify(loaded, packageName) {
            if (typeof loaded !== "function") {
                throw new Error(
                    `${packageName} did not load a Database constructor`,
                );
            }
        },
    },
    {
        packageName: NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.Sharp,
        issuerPath: path.join(
            rootDir,
            "indexer",
            "dist-desktop",
            "bootstrap-worker.mjs",
        ),
        verify(loaded, packageName) {
            const versions = loaded?.versions ?? loaded?.default?.versions;
            if (!versions?.sharp || !versions?.vips) {
                throw new Error(
                    `${packageName} did not expose native image processing versions`,
                );
            }
        },
    },
];

for (const check of nativeRuntimeDependencyChecks) {
    await assertIssuerExists(check);

    // Resolve from the same package boundary used by bundled runtime artifacts.
    const requireFromRuntimeIssuer = createRequire(check.issuerPath);
    const loaded = requireFromRuntimeIssuer(check.packageName);
    check.verify(loaded, check.packageName);

    console.log(`Verified native runtime dependency: ${check.packageName}`);
}

async function assertIssuerExists(check) {
    try {
        await access(check.issuerPath);
    } catch {
        throw new Error(
            `Missing issuer for ${check.packageName}: ${path.relative(
                rootDir,
                check.issuerPath,
            )}. Run yarn build:runtime first.`,
        );
    }
}
