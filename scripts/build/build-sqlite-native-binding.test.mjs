import assert from "node:assert/strict";
import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    SQLITE_NATIVE_BUILD_METADATA_FILE_NAME,
    buildSqliteNativeBinding,
} from "./build-sqlite-native-binding.mjs";
import {
    BETTER_SQLITE3_NATIVE_BINDING_RELATIVE_PATH,
    DESKTOP_BUILD_TARGET_ENV_KEYS,
    DESKTOP_NODE_ARCHITECTURE,
    DESKTOP_NODE_DIST_TARGET,
    MACOS_UNIVERSAL_NATIVE_ARCHITECTURES,
} from "./native-runtime-dependencies.mjs";

test("universal macOS SQLite builds both slices before assembly", async (t) => {
    const fixture = await createSqliteFixture(t);
    const installedArchitectures = [];
    const messages = [];

    const bindingPath = await buildSqliteNativeBinding({
        rootDir: fixture.rootDir,
        environment: {
            [DESKTOP_BUILD_TARGET_ENV_KEYS.NodeDistributionTarget]:
                DESKTOP_NODE_DIST_TARGET.DarwinUniversal,
        },
        platform: "darwin",
        arch: DESKTOP_NODE_ARCHITECTURE.Arm64,
        temporaryDirectory: fixture.temporaryDirectory,
        nodeVersion: "v24.3.0",
        nodeModulesAbi: "137",
        async packageInstaller({ packageDir, nodeArchitecture }) {
            installedArchitectures.push(nodeArchitecture);
            await writeFixtureFile(
                path.join(
                    packageDir,
                    BETTER_SQLITE3_NATIVE_BINDING_RELATIVE_PATH,
                ),
                nodeArchitecture,
            );
        },
        async universalAssembler({ slices, outputPath }) {
            assert.deepEqual(
                slices.map(({ nodeArchitecture, machOArchitecture }) => ({
                    nodeArchitecture,
                    machOArchitecture,
                })),
                MACOS_UNIVERSAL_NATIVE_ARCHITECTURES.map(
                    ({ nodeArchitecture, machOArchitecture }) => ({
                        nodeArchitecture,
                        machOArchitecture,
                    }),
                ),
            );
            const contents = await Promise.all(
                slices.map((slice) => readFile(slice.path, "utf8")),
            );
            await writeFile(outputPath, contents.join("+"), "utf8");
        },
        logger(message) {
            messages.push(message);
        },
    });

    assert.deepEqual(
        installedArchitectures,
        MACOS_UNIVERSAL_NATIVE_ARCHITECTURES.map(
            ({ nodeArchitecture }) => nodeArchitecture,
        ),
    );
    assert.equal(await readFile(bindingPath, "utf8"), "arm64+x64");
    assert.deepEqual(
        JSON.parse(
            await readFile(
                path.join(
                    path.dirname(bindingPath),
                    SQLITE_NATIVE_BUILD_METADATA_FILE_NAME,
                ),
                "utf8",
            ),
        ),
        {
            schemaVersion: 1,
            packageName: "better-sqlite3",
            packageVersion: "12.10.0",
            nodeVersion: "v24.3.0",
            nodeModulesAbi: "137",
            target: DESKTOP_NODE_DIST_TARGET.DarwinUniversal,
        },
    );
    assert.match(messages[0], /darwin-universal/);
    assert.deepEqual(await readdir(fixture.temporaryDirectory), []);
});

test("Tauri build hook reuses a compatible SQLite binding", async (t) => {
    const fixture = await createSqliteFixture(t);
    const bindingPath = path.join(
        fixture.packageDir,
        BETTER_SQLITE3_NATIVE_BINDING_RELATIVE_PATH,
    );
    await writeFixtureFile(bindingPath, "existing-universal-binding");
    const messages = [];

    const resolvedPath = await buildSqliteNativeBinding({
        rootDir: fixture.rootDir,
        environment: {
            [DESKTOP_BUILD_TARGET_ENV_KEYS.NodeDistributionTarget]:
                DESKTOP_NODE_DIST_TARGET.DarwinUniversal,
        },
        platform: "darwin",
        arch: DESKTOP_NODE_ARCHITECTURE.Arm64,
        buildIfNeeded: true,
        async bindingCompatibilityChecker() {
            return true;
        },
        async packageInstaller() {
            assert.fail("A compatible binding must not be rebuilt.");
        },
        async universalAssembler() {
            assert.fail("A compatible binding must not be reassembled.");
        },
        logger(message) {
            messages.push(message);
        },
    });

    assert.equal(resolvedPath, bindingPath);
    assert.equal(
        await readFile(bindingPath, "utf8"),
        "existing-universal-binding",
    );
    assert.match(messages[0], /Reusing compatible/);
});

test("concrete desktop targets build one matching Node architecture", async (t) => {
    const fixture = await createSqliteFixture(t);
    const installedArchitectures = [];

    const bindingPath = await buildSqliteNativeBinding({
        rootDir: fixture.rootDir,
        environment: {
            [DESKTOP_BUILD_TARGET_ENV_KEYS.NodeDistributionTarget]:
                DESKTOP_NODE_DIST_TARGET.LinuxX64,
        },
        platform: "linux",
        arch: DESKTOP_NODE_ARCHITECTURE.X64,
        async packageInstaller({ packageDir, nodeArchitecture }) {
            installedArchitectures.push(nodeArchitecture);
            await writeFixtureFile(
                path.join(
                    packageDir,
                    BETTER_SQLITE3_NATIVE_BINDING_RELATIVE_PATH,
                ),
                nodeArchitecture,
            );
        },
        logger() {},
    });

    assert.deepEqual(installedArchitectures, [DESKTOP_NODE_ARCHITECTURE.X64]);
    assert.equal(
        await readFile(bindingPath, "utf8"),
        DESKTOP_NODE_ARCHITECTURE.X64,
    );
});

test("if-needed reuse requires matching package and Node build metadata", async (t) => {
    const fixture = await createSqliteFixture(t);
    let buildCount = 0;
    const baseOptions = {
        rootDir: fixture.rootDir,
        environment: {
            [DESKTOP_BUILD_TARGET_ENV_KEYS.NodeDistributionTarget]:
                DESKTOP_NODE_DIST_TARGET.LinuxX64,
        },
        platform: "linux",
        arch: DESKTOP_NODE_ARCHITECTURE.X64,
        nodeVersion: "v24.3.0",
        nodeModulesAbi: "137",
        async packageInstaller({ packageDir }) {
            buildCount += 1;
            await writeFixtureFile(
                path.join(
                    packageDir,
                    BETTER_SQLITE3_NATIVE_BINDING_RELATIVE_PATH,
                ),
                `build-${buildCount}`,
            );
        },
        logger() {},
    };

    await buildSqliteNativeBinding(baseOptions);
    await buildSqliteNativeBinding({ ...baseOptions, buildIfNeeded: true });
    assert.equal(buildCount, 1);

    await buildSqliteNativeBinding({
        ...baseOptions,
        buildIfNeeded: true,
        nodeVersion: "v24.4.0",
    });
    assert.equal(buildCount, 2);
});

async function createSqliteFixture(t) {
    const rootDir = await mkdtemp(
        path.join(os.tmpdir(), "artgod-sqlite-build-"),
    );
    const temporaryDirectory = path.join(rootDir, "temporary");
    const packageDir = path.join(
        rootDir,
        ".yarn",
        "unplugged",
        "better-sqlite3-fixture",
        "node_modules",
        "better-sqlite3",
    );
    await mkdir(packageDir, { recursive: true });
    await writeFile(
        path.join(packageDir, "package.json"),
        `${JSON.stringify({ name: "better-sqlite3", version: "12.10.0" })}\n`,
        "utf8",
    );
    await mkdir(temporaryDirectory, { recursive: true });
    t.after(() => rm(rootDir, { recursive: true, force: true }));
    return { rootDir, packageDir, temporaryDirectory };
}

async function writeFixtureFile(filePath, contents) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, "utf8");
}
