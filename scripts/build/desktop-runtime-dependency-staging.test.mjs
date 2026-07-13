import assert from "node:assert/strict";
import {
    lstat,
    mkdir,
    mkdtemp,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    assertDesktopRuntimeBuildProfileMarkers,
    assertNoForbiddenDesktopRuntimePaths,
    copyReviewedPackageFiles,
    stageDesktopRuntimeDependencies,
    validateExactRegularFileTree,
} from "./desktop-runtime-dependency-staging.mjs";
import {
    BETTER_SQLITE3_NATIVE_BINDING_RELATIVE_PATH,
    DESKTOP_NODE_DIST_TARGET,
    DESKTOP_RUNTIME_DEPENDENCY_ROOTS,
    FORBIDDEN_DESKTOP_RUNTIME_PNP_PATHS,
    NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES,
    getDesktopRuntimeDependencyPackageNames,
    getDesktopRuntimePackageFileSelection,
} from "./native-runtime-dependencies.mjs";
import {
    RUNTIME_BUILD_PROFILE,
    RUNTIME_BUILD_PROFILE_MARKER_FILE_NAME,
    runtimeBuildProfileMarkerSource,
} from "./runtime-build-profile.mjs";

const REVIEWED_DIRECTORY_PATHS = new Set([
    "lib",
    "classes",
    "functions",
    "internal",
    "ranges",
]);

test("staging materializes isolated reviewed dependency trees", async (t) => {
    const temporaryRoot = await createTemporaryRoot(t);
    const projectRoot = path.join(temporaryRoot, "project");
    const destinationRoot = path.join(temporaryRoot, "resources");
    const packageSources = new Map();
    const directResolutionIssuers = [];
    await createRuntimeArtifacts(
        destinationRoot,
        RUNTIME_BUILD_PROFILE.DESKTOP,
    );

    const packageNames = getDesktopRuntimeDependencyPackageNames(
        DESKTOP_RUNTIME_DEPENDENCY_ROOTS.Backend,
        DESKTOP_NODE_DIST_TARGET.LinuxX64,
    );
    for (const [index, packageName] of packageNames.entries()) {
        const sourceRoot = path.join(
            temporaryRoot,
            "packages",
            `${String(index)}-${packageName.replaceAll("/", "-")}`,
        );
        await createReviewedPackageFixture(sourceRoot, packageName);
        packageSources.set(packageName, sourceRoot);
    }

    const pnpApi = {
        resolveToUnqualified(packageName, issuerPath) {
            if (
                packageName ===
                    NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.BetterSqlite3 ||
                packageName === NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.Sharp
            ) {
                directResolutionIssuers.push({
                    packageName,
                    issuerPath: path.relative(projectRoot, issuerPath),
                });
            }
            const sourceRoot = packageSources.get(packageName);
            if (!sourceRoot) {
                throw new Error(
                    `Unexpected package resolution: ${packageName}`,
                );
            }
            return sourceRoot;
        },
    };

    await stageDesktopRuntimeDependencies({
        rootDir: projectRoot,
        destinationRootDir: destinationRoot,
        nodeTarget: DESKTOP_NODE_DIST_TARGET.LinuxX64,
        pnpApi,
    });

    assert.deepEqual(
        directResolutionIssuers
            .map(
                ({ packageName, issuerPath }) => `${packageName}:${issuerPath}`,
            )
            .sort(),
        [
            "better-sqlite3:backend/package.json",
            "better-sqlite3:indexer/package.json",
            "better-sqlite3:trading/package.json",
            "sharp:backend/package.json",
            "sharp:indexer/package.json",
        ],
    );

    assert.equal(
        (
            await lstat(
                path.join(
                    destinationRoot,
                    "backend",
                    "node_modules",
                    NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.BetterSqlite3,
                    BETTER_SQLITE3_NATIVE_BINDING_RELATIVE_PATH,
                ),
            )
        ).isFile(),
        true,
    );
    assert.equal(
        (
            await lstat(
                path.join(
                    destinationRoot,
                    "backend",
                    "node_modules",
                    NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.Sharp,
                    "lib",
                    "fixture.js",
                ),
            )
        ).isFile(),
        true,
    );
    await assert.rejects(
        lstat(
            path.join(
                destinationRoot,
                "trading",
                "node_modules",
                NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.Sharp,
            ),
        ),
        { code: "ENOENT" },
    );
});

test("desktop profile markers reject full artifacts before staging", async (t) => {
    const temporaryRoot = await createTemporaryRoot(t);
    await createRuntimeArtifacts(temporaryRoot, RUNTIME_BUILD_PROFILE.DESKTOP);
    await assertDesktopRuntimeBuildProfileMarkers(temporaryRoot);

    const tradingMarkerPath = path.join(
        temporaryRoot,
        DESKTOP_RUNTIME_DEPENDENCY_ROOTS.Trading.directoryName,
        "dist-desktop",
        RUNTIME_BUILD_PROFILE_MARKER_FILE_NAME,
    );
    await writeFile(
        tradingMarkerPath,
        runtimeBuildProfileMarkerSource(RUNTIME_BUILD_PROFILE.FULL),
    );
    await assert.rejects(
        assertDesktopRuntimeBuildProfileMarkers(temporaryRoot),
        /Refusing to stage trading runtime artifacts built with the full profile/,
    );
});

test("reviewed source selections reject symlinks", async (t) => {
    const temporaryRoot = await createTemporaryRoot(t);
    const sourceRoot = path.join(temporaryRoot, "source");
    const externalRoot = path.join(temporaryRoot, "external");
    await writeFixtureFile(path.join(externalRoot, "outside.js"));
    await mkdir(path.join(sourceRoot, "lib"), { recursive: true });
    await symlink(
        externalRoot,
        path.join(sourceRoot, "lib", "linked"),
        process.platform === "win32" ? "junction" : "dir",
    );

    await assert.rejects(
        copyReviewedPackageFiles({
            sourceRoot,
            destinationRoot: path.join(temporaryRoot, "destination"),
            selection: { required: ["lib"], optional: [] },
            packageName: "fixture-package",
        }),
        /Symlink is forbidden/,
    );
});

test("exact-tree validation rejects unexpected files and links", async (t) => {
    const temporaryRoot = await createTemporaryRoot(t);
    const stagedRoot = path.join(temporaryRoot, "staged");
    await writeFixtureFile(path.join(stagedRoot, "expected.js"));
    await writeFixtureFile(path.join(stagedRoot, "unexpected.js"));
    await assert.rejects(
        validateExactRegularFileTree({
            rootDir: stagedRoot,
            expectedRelativePaths: new Set(["expected.js"]),
            label: "fixture tree",
        }),
        /unexpected \(1\): unexpected\.js/,
    );

    await rm(path.join(stagedRoot, "unexpected.js"));
    const externalRoot = path.join(temporaryRoot, "external");
    await writeFixtureFile(path.join(externalRoot, "outside.js"));
    await symlink(
        externalRoot,
        path.join(stagedRoot, "linked"),
        process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
        validateExactRegularFileTree({
            rootDir: stagedRoot,
            expectedRelativePaths: new Set(["expected.js"]),
            label: "fixture tree",
        }),
        /Symlink is forbidden/,
    );
});

test("reviewed selections cannot escape their package root", async (t) => {
    const temporaryRoot = await createTemporaryRoot(t);
    const sourceRoot = path.join(temporaryRoot, "source");
    await mkdir(sourceRoot, { recursive: true });
    await assert.rejects(
        copyReviewedPackageFiles({
            sourceRoot,
            destinationRoot: path.join(temporaryRoot, "destination"),
            selection: { required: ["../outside.js"], optional: [] },
            packageName: "fixture-package",
        }),
        /escapes its package/,
    );
});

test("desktop resources reject Yarn PnP runtime state", async (t) => {
    const temporaryRoot = await createTemporaryRoot(t);
    await assertNoForbiddenDesktopRuntimePaths(temporaryRoot);

    for (const [
        index,
        relativePath,
    ] of FORBIDDEN_DESKTOP_RUNTIME_PNP_PATHS.entries()) {
        const fixtureRoot = path.join(temporaryRoot, String(index));
        const forbiddenPath =
            relativePath === ".yarn"
                ? path.join(fixtureRoot, relativePath, "cache", "package.zip")
                : path.join(fixtureRoot, relativePath);
        await writeFixtureFile(forbiddenPath);
        await assert.rejects(
            assertNoForbiddenDesktopRuntimePaths(fixtureRoot),
            /Forbidden Yarn project runtime path was staged/,
        );
    }
});

async function createTemporaryRoot(t) {
    const temporaryRoot = await mkdtemp(
        path.join(os.tmpdir(), "artgod-runtime-staging-"),
    );
    t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
    return temporaryRoot;
}

async function createRuntimeArtifacts(rootDir, profile) {
    for (const runtime of Object.values(DESKTOP_RUNTIME_DEPENDENCY_ROOTS)) {
        const runtimeDirectory = path.join(rootDir, runtime.directoryName);
        await writeFixtureFile(
            path.join(runtimeDirectory, runtime.issuerRelativePath),
        );
        await writeFixtureFile(
            path.join(
                runtimeDirectory,
                "dist-desktop",
                RUNTIME_BUILD_PROFILE_MARKER_FILE_NAME,
            ),
            runtimeBuildProfileMarkerSource(profile),
        );
    }
}

async function createReviewedPackageFixture(sourceRoot, packageName) {
    const selection = getDesktopRuntimePackageFileSelection(packageName);
    for (const relativePath of selection.required) {
        if (REVIEWED_DIRECTORY_PATHS.has(relativePath)) {
            await writeFixtureFile(
                path.join(sourceRoot, relativePath, "fixture.js"),
            );
            continue;
        }
        await writeFixtureFile(path.join(sourceRoot, relativePath));
    }
}

async function writeFixtureFile(filePath, content = "fixture\n") {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
}
