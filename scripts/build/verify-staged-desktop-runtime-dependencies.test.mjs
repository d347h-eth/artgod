import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    DESKTOP_RUNTIME_DEPENDENCY_ROOTS,
    NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES,
} from "./native-runtime-dependencies.mjs";
import { verifyStagedDesktopRuntimeDependencies } from "./verify-staged-desktop-runtime-dependencies.mjs";

const fakeSqliteSource = `
class FakeDatabase {
    prepare() {
        return { get: () => ({ value: 1 }) };
    }

    close() {}
}

module.exports = FakeDatabase;
`;

const fakeSharpSource = `
module.exports = () => ({
    png() {
        return this;
    },
    async toBuffer() {
        return Buffer.from([1]);
    },
});
`;

test("staged dependency smoke uses isolated node_modules without inherited PnP", async (t) => {
    const resourcesRootDir = await mkdtemp(
        path.join(os.tmpdir(), "artgod-native-smoke-"),
    );
    t.after(() => rm(resourcesRootDir, { recursive: true, force: true }));

    for (const runtime of Object.values(DESKTOP_RUNTIME_DEPENDENCY_ROOTS)) {
        const runtimeRoot = path.join(resourcesRootDir, runtime.directoryName);
        await writeFixtureFile(
            path.join(runtimeRoot, runtime.issuerRelativePath),
            "export {};\n",
        );
        await writeCommonJsPackage(
            runtimeRoot,
            NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.BetterSqlite3,
            fakeSqliteSource,
        );
        if (runtime.includeSharp) {
            await writeCommonJsPackage(
                runtimeRoot,
                NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.Sharp,
                fakeSharpSource,
            );
        }
    }

    await verifyStagedDesktopRuntimeDependencies({
        resourcesRootDir,
        nodeBinaryPath: process.execPath,
        environment: {
            ...process.env,
            NODE_OPTIONS:
                "--require=/definitely-not-present/artgod-pnp-hook.cjs",
            NODE_PATH: "/definitely-not-present/artgod-node-path",
        },
    });
});

async function writeCommonJsPackage(runtimeRoot, packageName, source) {
    const packageRoot = path.join(runtimeRoot, "node_modules", packageName);
    await writeFixtureFile(
        path.join(packageRoot, "package.json"),
        `${JSON.stringify({ name: packageName, main: "index.js" })}\n`,
    );
    await writeFixtureFile(path.join(packageRoot, "index.js"), source);
}

async function writeFixtureFile(filePath, source) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, source);
}
