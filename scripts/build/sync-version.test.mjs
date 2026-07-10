import assert from "node:assert/strict";
import {
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
    assertProjectVersionsSynchronized,
    findProjectVersionMismatches,
    PROJECT_VERSION_FILE_PATHS,
    PROJECT_VERSION_TARGET_PATHS,
    synchronizeProjectVersion,
} from "./sync-version.mjs";

const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
);
const synchronizedTestVersion = "9.8.7-test.1";
const driftedTestVersion = "0.0.0-drifted";

test("synchronizes every owned version target and checks without rewriting", async () => {
    const fixtureRoot = await createProjectFixture();

    try {
        const rootPackagePath = path.join(fixtureRoot, "package.json");
        const rootPackage = JSON.parse(await readFile(rootPackagePath, "utf8"));
        rootPackage.version = synchronizedTestVersion;
        await writeFile(
            rootPackagePath,
            `${JSON.stringify(rootPackage, null, 4)}\n`,
            "utf8",
        );

        const firstSync = await synchronizeProjectVersion(fixtureRoot);
        assert.equal(firstSync.version, synchronizedTestVersion);
        assert.deepEqual(firstSync.updatedPaths, PROJECT_VERSION_TARGET_PATHS);
        assert.equal(
            await assertProjectVersionsSynchronized(fixtureRoot),
            synchronizedTestVersion,
        );

        const secondSync = await synchronizeProjectVersion(fixtureRoot);
        assert.deepEqual(secondSync.updatedPaths, []);
    } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
    }
});

test("reports version drift without modifying the target", async () => {
    const fixtureRoot = await createProjectFixture();
    const driftedRelativePath = PROJECT_VERSION_TARGET_PATHS[0];
    const driftedPath = path.join(fixtureRoot, driftedRelativePath);

    try {
        const packageJson = JSON.parse(await readFile(driftedPath, "utf8"));
        packageJson.version = driftedTestVersion;
        const driftedSource = `${JSON.stringify(packageJson, null, 4)}\n`;
        await writeFile(driftedPath, driftedSource, "utf8");

        assert.deepEqual(await findProjectVersionMismatches(fixtureRoot), [
            {
                relativePath: driftedRelativePath,
                actualVersion: driftedTestVersion,
                expectedVersion: JSON.parse(
                    await readFile(
                        path.join(fixtureRoot, "package.json"),
                        "utf8",
                    ),
                ).version,
            },
        ]);
        await assert.rejects(
            assertProjectVersionsSynchronized(fixtureRoot),
            /Run yarn sync:version/,
        );
        assert.equal(await readFile(driftedPath, "utf8"), driftedSource);
    } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
    }
});

async function createProjectFixture() {
    const fixtureRoot = await mkdtemp(
        path.join(os.tmpdir(), "artgod-version-contract-test-"),
    );
    for (const relativePath of PROJECT_VERSION_FILE_PATHS) {
        const targetPath = path.join(fixtureRoot, relativePath);
        await mkdir(path.dirname(targetPath), { recursive: true });
        await copyFile(path.join(projectRoot, relativePath), targetPath);
    }
    return fixtureRoot;
}
