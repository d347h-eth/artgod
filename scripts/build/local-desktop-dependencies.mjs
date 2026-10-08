import { mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import {
    copyReviewedPackageFiles,
    assertNoForbiddenDesktopRuntimePaths,
    validateExactRegularFileTree,
    resolveDesktopRuntimePackageSource,
} from "./desktop-runtime-dependency-staging.mjs";
import {
    DESKTOP_RUNTIME_DEPENDENCY_ROOTS,
    getDesktopRuntimeDependencyPackageNames,
    getDesktopRuntimePackageFileSelection,
    getDesktopRuntimePackageSourceIssuer,
} from "./native-runtime-dependencies.mjs";
import {
    assertLocalProfile,
    LOCAL_PROFILE_MARKER,
} from "./local-desktop-contract.mjs";

export const PYROSCOPE_PACKAGE = "@pyroscope/nodejs";
export const PPROF_PACKAGE = "@datadog/pprof";
const profilerFiles = {
    [PYROSCOPE_PACKAGE]: ["LICENSE", "dist"],
    [PPROF_PACKAGE]: ["LICENSE", "out"],
    debug: ["LICENSE", "src"],
    ms: ["license.md", "index.js"],
    "p-limit": ["license", "index.js"],
    "yocto-queue": ["license", "index.js"],
    "regenerator-runtime": ["LICENSE", "runtime.js", "path.js"],
    "source-map": ["LICENSE", "source-map.js", "lib"],
    "node-gyp-build": ["LICENSE", "index.js", "node-gyp-build.js"],
    "pprof-format": ["LICENSE", "NOTICE", "LICENSE-3rdparty.csv", "dist"],
};

// node-gyp-build selects these package-local prebuilds. Ship only the bundled Node ABI.
export function profilerNativeFiles(nodeTarget, nodeAbi) {
    if (!/^\d+$/.test(String(nodeAbi)))
        throw new Error("The bundled Node ABI is required.");
    const targets =
        nodeTarget === "darwin-universal"
            ? ["darwin-x64", "darwin-arm64"]
            : [nodeTarget];
    return targets.map((target) => {
        const platform = target.replace(/^win-/, "win32-");
        if (
            ![
                "linux-x64",
                "linux-arm64",
                "darwin-x64",
                "darwin-arm64",
                "win32-x64",
            ].includes(platform)
        ) {
            throw new Error(
                `The locked pprof package has no local desktop prebuild for ${target}.`,
            );
        }
        return `prebuilds/${platform}/dd_pprof.node.abi${nodeAbi}.node`;
    });
}

export async function assertLocalRuntimeProfiles(resourcesRoot) {
    for (const runtime of Object.values(DESKTOP_RUNTIME_DEPENDENCY_ROOTS)) {
        const marker = path.join(
            resourcesRoot,
            runtime.directoryName,
            "dist-desktop",
            LOCAL_PROFILE_MARKER,
        );
        assertLocalProfile(
            JSON.parse(await readFile(marker, "utf8")),
            runtime.directoryName,
        );
    }
}

// Local-only admission policy. The production stager remains deliberately stricter.
export async function stageLocalDesktopDependencies({
    rootDir,
    destinationRootDir,
    nodeTarget,
    nodeAbi,
    pnpApi = createRequire(import.meta.url)("pnpapi"),
}) {
    await assertLocalRuntimeProfiles(destinationRootDir);
    await assertNoForbiddenDesktopRuntimePaths(destinationRootDir);
    for (const runtime of Object.values(DESKTOP_RUNTIME_DEPENDENCY_ROOTS)) {
        const destination = path.join(
            destinationRootDir,
            runtime.directoryName,
            "node_modules",
        );
        await rm(destination, { recursive: true, force: true });
        await mkdir(destination, { recursive: true });
        const expected = new Set();
        const nativeSources = new Map();
        const resolveNative = async (name) => {
            if (nativeSources.has(name)) return nativeSources.get(name);
            const issuer = getDesktopRuntimePackageSourceIssuer(name, runtime);
            const from = issuer.workspaceRelativePath
                ? path.join(rootDir, issuer.workspaceRelativePath)
                : path.join(
                      await resolveNative(issuer.packageName),
                      "package.json",
                  );
            const source = await resolveDesktopRuntimePackageSource({
                packageName: name,
                issuerPath: from,
                pnpApi,
            });
            nativeSources.set(name, source);
            return source;
        };
        const copyPackage = async (name, sourceRoot, selection) => {
            const files = await copyReviewedPackageFiles({
                packageName: name,
                sourceRoot,
                destinationRoot: path.join(destination, name),
                selection,
            });
            for (const file of files) expected.add(`${name}/${file}`);
        };
        for (const name of getDesktopRuntimeDependencyPackageNames(
            runtime,
            nodeTarget,
        )) {
            await copyPackage(
                name,
                await resolveNative(name),
                getDesktopRuntimePackageFileSelection(name),
            );
        }
        if (runtime.directoryName !== "trading") {
            const sources = new Map();
            const copyProfiler = async (name, issuer) => {
                if (!Object.hasOwn(profilerFiles, name))
                    throw new Error(
                        `Unreviewed local profiler dependency: ${name}`,
                    );
                const source = await resolveDesktopRuntimePackageSource({
                    packageName: name,
                    issuerPath: issuer,
                    pnpApi,
                });
                if (sources.has(name)) {
                    if (sources.get(name) !== source)
                        throw new Error(
                            `Conflicting local profiler versions: ${name}`,
                        );
                    return;
                }
                sources.set(name, source);
                const manifest = JSON.parse(
                    await readFile(path.join(source, "package.json"), "utf8"),
                );
                await copyPackage(name, source, {
                    required: [
                        "package.json",
                        ...profilerFiles[name],
                        ...(name === PPROF_PACKAGE
                            ? profilerNativeFiles(nodeTarget, nodeAbi)
                            : []),
                    ],
                    optional: [],
                });
                for (const dependency of Object.keys(
                    manifest.dependencies ?? {},
                )) {
                    await copyProfiler(
                        dependency,
                        path.join(source, "package.json"),
                    );
                }
            };
            await copyProfiler(
                PYROSCOPE_PACKAGE,
                path.join(rootDir, "shared/package.json"),
            );
        }
        await validateExactRegularFileTree({
            rootDir: destination,
            expectedRelativePaths: expected,
            label: `${runtime.directoryName} local desktop dependencies`,
        });
    }
}
