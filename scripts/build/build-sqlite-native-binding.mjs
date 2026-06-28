#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    BETTER_SQLITE3_NATIVE_BINDING_RELATIVE_PATH,
    NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES,
} from "./native-runtime-dependencies.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");
const unpluggedDir = path.join(rootDir, ".yarn", "unplugged");
const sqlitePackageName = NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.BetterSqlite3;

const sqlitePackageDir = await findUnpluggedPackageDir(
    unpluggedDir,
    sqlitePackageName,
);
if (!sqlitePackageDir) {
    throw new Error(
        `Missing unplugged ${sqlitePackageName} package under ${path.relative(
            rootDir,
            unpluggedDir,
        )}. Run yarn install first.`,
    );
}

runPackageInstall(sqlitePackageDir);

const nativeBindingPath = path.join(
    sqlitePackageDir,
    BETTER_SQLITE3_NATIVE_BINDING_RELATIVE_PATH,
);
await assertFileExists(nativeBindingPath);

console.log(
    `Built ${sqlitePackageName} native binding: ${path.relative(
        rootDir,
        nativeBindingPath,
    )}`,
);

async function findUnpluggedPackageDir(baseDir, packageName) {
    await assertDirectoryExists(baseDir);

    const pendingDirs = [baseDir];
    while (pendingDirs.length > 0) {
        const currentDir = pendingDirs.pop();
        const entries = await readdir(currentDir, { withFileTypes: true });

        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }

            const entryPath = path.join(currentDir, entry.name);
            if (
                entry.name === packageName &&
                path.basename(path.dirname(entryPath)) === "node_modules"
            ) {
                return entryPath;
            }

            pendingDirs.push(entryPath);
        }
    }

    return undefined;
}

function runPackageInstall(packageDir) {
    const yarnBinary = process.platform === "win32" ? "yarn.cmd" : "yarn";
    const result = spawnSync(yarnBinary, ["run", "install"], {
        cwd: packageDir,
        env: {
            ...process.env,
            npm_config_build_from_source: "true",
        },
        stdio: "inherit",
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        throw new Error(
            `${sqlitePackageName} native build failed with status ${result.status}`,
        );
    }
}

async function assertDirectoryExists(dirPath) {
    try {
        await access(dirPath, fsConstants.R_OK);
    } catch {
        throw new Error(
            `Missing required directory: ${path.relative(rootDir, dirPath)}`,
        );
    }
}

async function assertFileExists(filePath) {
    try {
        await access(filePath, fsConstants.R_OK);
    } catch {
        throw new Error(`Missing native binding: ${path.relative(rootDir, filePath)}`);
    }
}
