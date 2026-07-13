import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    DESKTOP_RUNTIME_DEPENDENCY_ROOTS,
    NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES,
} from "./native-runtime-dependencies.mjs";

const SQLITE_MEMORY_DATABASE = ":memory:";
const SQLITE_SMOKE_QUERY = "SELECT 1 AS value";
const SQLITE_SMOKE_VALUE = 1;
const NATIVE_SMOKE_INCLUDE_SHARP_ARGUMENT = "include-sharp";
const SHARP_SMOKE_PIXEL = Object.freeze({
    width: 1,
    height: 1,
    channels: 4,
    background: Object.freeze({ r: 0, g: 0, b: 0, alpha: 1 }),
});

const smokeSource = `
import { createRequire } from "node:module";

const issuerPath = process.argv[1];
const includeSharp = process.argv[2] === ${JSON.stringify(NATIVE_SMOKE_INCLUDE_SHARP_ARGUMENT)};
const require = createRequire(issuerPath);
const Database = require(${JSON.stringify(NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.BetterSqlite3)});
const database = new Database(${JSON.stringify(SQLITE_MEMORY_DATABASE)});
try {
    const row = database.prepare(${JSON.stringify(SQLITE_SMOKE_QUERY)}).get();
    if (row?.value !== ${SQLITE_SMOKE_VALUE}) {
        throw new Error("better-sqlite3 returned an unexpected smoke-query result.");
    }
} finally {
    database.close();
}

if (includeSharp) {
    const sharp = require(${JSON.stringify(NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.Sharp)});
    const image = await sharp({ create: ${JSON.stringify(SHARP_SMOKE_PIXEL)} })
        .png()
        .toBuffer();
    if (!Buffer.isBuffer(image) || image.length === 0) {
        throw new Error("sharp returned an empty smoke image.");
    }
}
`;

// Loads and executes each staged native package through its production issuer tree.
export async function verifyStagedDesktopRuntimeDependencies({
    resourcesRootDir,
    nodeBinaryPath,
    environment = process.env,
}) {
    await assertRegularFile(nodeBinaryPath, "bundled Node binary");

    for (const runtime of Object.values(DESKTOP_RUNTIME_DEPENDENCY_ROOTS)) {
        const issuerPath = path.join(
            resourcesRootDir,
            runtime.directoryName,
            runtime.issuerRelativePath,
        );
        await assertRegularFile(
            issuerPath,
            `${runtime.directoryName} desktop runtime artifact`,
        );
        await runNativeDependencySmoke({
            nodeBinaryPath,
            issuerPath,
            includeSharp: runtime.includeSharp,
            environment,
            runtimeName: runtime.directoryName,
            resourcesRootDir,
        });
    }
}

async function assertRegularFile(filePath, description) {
    let metadata;
    try {
        metadata = await lstat(filePath);
    } catch (error) {
        throw new Error(`${description} is unavailable: ${filePath}. ${error}`);
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error(`${description} is not a regular file: ${filePath}`);
    }
}

async function runNativeDependencySmoke({
    nodeBinaryPath,
    issuerPath,
    includeSharp,
    environment,
    runtimeName,
    resourcesRootDir,
}) {
    const childEnvironment = { ...environment };
    // Exercise normal node_modules resolution without inheriting the build's PnP hook.
    delete childEnvironment.NODE_OPTIONS;
    delete childEnvironment.NODE_PATH;

    await new Promise((resolve, reject) => {
        const child = spawn(
            nodeBinaryPath,
            [
                "--input-type=module",
                "--eval",
                smokeSource,
                issuerPath,
                includeSharp ? NATIVE_SMOKE_INCLUDE_SHARP_ARGUMENT : "",
            ],
            {
                cwd: resourcesRootDir,
                env: childEnvironment,
                stdio: "inherit",
            },
        );
        child.once("error", (error) => {
            reject(
                new Error(
                    `Unable to start ${runtimeName} staged native dependency smoke: ${String(error)}`,
                ),
            );
        });
        child.once("exit", (code, signal) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(
                new Error(
                    `${runtimeName} staged native dependency smoke failed with code ${String(code)} and signal ${String(signal)}.`,
                ),
            );
        });
    });
}

const invokedScriptPath = process.argv[1]
    ? path.resolve(process.argv[1])
    : undefined;
if (
    invokedScriptPath &&
    import.meta.url === pathToFileURL(invokedScriptPath).href
) {
    const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
    const rootDir = path.resolve(scriptDirectory, "../..");
    const resourcesRootDir = path.join(
        rootDir,
        "src-tauri",
        "resources",
        "runtime",
    );
    const nodeBinaryPath = path.join(
        resourcesRootDir,
        "node",
        process.platform === "win32" ? "node.exe" : "node",
    );
    await verifyStagedDesktopRuntimeDependencies({
        resourcesRootDir,
        nodeBinaryPath,
    });
    console.log("Verified staged desktop native runtime dependencies.");
}
