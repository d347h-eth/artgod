#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
    access,
    copyFile,
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
    BETTER_SQLITE3_NATIVE_BINDING_RELATIVE_PATH,
    DESKTOP_BUILD_TARGET_ENV_KEYS,
    DESKTOP_NODE_DIST_TARGET,
    MACOS_UNIVERSAL_NATIVE_ARCHITECTURES,
    NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES,
    getDesktopNativeNodeArchitectures,
    getMacOSMachOArchitectures,
    inferDesktopNodeDistTarget,
    resolveDesktopDistributionTargetFromEnvironment,
} from "./native-runtime-dependencies.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultRootDir = path.resolve(__dirname, "../..");
const sqlitePackageName = NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.BetterSqlite3;
// Apple tool used to assemble and verify universal Mach-O bindings.
const LIPO_COMMAND = "lipo";
// This variadic command requires the input path before its architecture arguments.
const LIPO_VERIFY_ARCH_COMMAND = "-verify_arch";

// Reuses an already compatible binding when this script runs inside Tauri's build hook.
const BUILD_IF_NEEDED_ARGUMENT = "--if-needed";
// Records the package, Node ABI, and target that produced the reusable binding.
export const SQLITE_NATIVE_BUILD_METADATA_FILE_NAME =
    "artgod-native-build.json";
const SQLITE_NATIVE_BUILD_METADATA_SCHEMA_VERSION = 1;

// Builds the trusted SQLite binding for the resolved desktop target.
export async function buildSqliteNativeBinding({
    rootDir = defaultRootDir,
    environment = process.env,
    platform = process.platform,
    arch = process.arch,
    buildIfNeeded = false,
    packageInstaller = runPackageInstall,
    universalAssembler = assembleUniversalMacOSBinding,
    bindingCompatibilityChecker = isNativeBindingCompatible,
    temporaryDirectory = os.tmpdir(),
    nodeVersion = process.version,
    nodeModulesAbi = process.versions.modules,
    logger = console.log,
} = {}) {
    const unpluggedDir = path.join(rootDir, ".yarn", "unplugged");
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

    const nodeTarget = resolveDesktopDistributionTargetFromEnvironment({
        environment,
        distributionTargetEnvKey:
            DESKTOP_BUILD_TARGET_ENV_KEYS.NodeDistributionTarget,
        platform,
        arch,
    });
    const nativeBindingPath = path.join(
        sqlitePackageDir,
        BETTER_SQLITE3_NATIVE_BINDING_RELATIVE_PATH,
    );
    const buildMetadataPath = path.join(
        path.dirname(nativeBindingPath),
        SQLITE_NATIVE_BUILD_METADATA_FILE_NAME,
    );
    const expectedBuildMetadata = await createNativeBuildMetadata({
        sqlitePackageDir,
        nodeTarget,
        nodeVersion,
        nodeModulesAbi,
    });

    if (
        buildIfNeeded &&
        (await bindingCompatibilityChecker({
            nativeBindingPath,
            buildMetadataPath,
            expectedBuildMetadata,
            nodeTarget,
            platform,
            arch,
            environment,
        }))
    ) {
        logger(
            `Reusing compatible ${sqlitePackageName} native binding: ${path.relative(
                rootDir,
                nativeBindingPath,
            )} (${nodeTarget})`,
        );
        return nativeBindingPath;
    }

    // Invalidate reuse before a rebuild can replace the canonical binding.
    await rm(buildMetadataPath, { force: true });

    if (nodeTarget === DESKTOP_NODE_DIST_TARGET.DarwinUniversal) {
        if (platform !== "darwin") {
            throw new Error(
                `${DESKTOP_NODE_DIST_TARGET.DarwinUniversal} SQLite assembly requires running the build on macOS.`,
            );
        }
        await buildUniversalMacOSBinding({
            sqlitePackageDir,
            nativeBindingPath,
            environment,
            packageInstaller,
            universalAssembler,
            temporaryDirectory,
        });
    } else {
        const [nodeArchitecture] =
            getDesktopNativeNodeArchitectures(nodeTarget);
        await packageInstaller({
            packageDir: sqlitePackageDir,
            nodeArchitecture,
            environment,
        });
    }

    await assertFileExists(nativeBindingPath, rootDir);
    await writeFile(
        buildMetadataPath,
        `${JSON.stringify(expectedBuildMetadata, null, 2)}\n`,
        "utf8",
    );
    logger(
        `Built ${sqlitePackageName} native binding: ${path.relative(
            rootDir,
            nativeBindingPath,
        )} (${nodeTarget})`,
    );
    return nativeBindingPath;
}

async function createNativeBuildMetadata({
    sqlitePackageDir,
    nodeTarget,
    nodeVersion,
    nodeModulesAbi,
}) {
    const packageManifest = JSON.parse(
        await readFile(path.join(sqlitePackageDir, "package.json"), "utf8"),
    );
    const packageVersion = packageManifest.version?.trim();
    if (!packageVersion || !nodeVersion || !nodeModulesAbi) {
        throw new Error(
            `Unable to identify the ${sqlitePackageName} package and Node ABI for native binding metadata.`,
        );
    }
    return Object.freeze({
        schemaVersion: SQLITE_NATIVE_BUILD_METADATA_SCHEMA_VERSION,
        packageName: sqlitePackageName,
        packageVersion,
        nodeVersion,
        nodeModulesAbi,
        target: nodeTarget,
    });
}

async function buildUniversalMacOSBinding({
    sqlitePackageDir,
    nativeBindingPath,
    environment,
    packageInstaller,
    universalAssembler,
    temporaryDirectory,
}) {
    const sliceRootDir = await mkdtemp(
        path.join(temporaryDirectory, "artgod-sqlite-universal-"),
    );
    try {
        const slices = [];
        for (const architecture of MACOS_UNIVERSAL_NATIVE_ARCHITECTURES) {
            // Rebuild from a clean package-local output so no host slice is reused.
            await rm(path.join(sqlitePackageDir, "build"), {
                recursive: true,
                force: true,
            });
            await packageInstaller({
                packageDir: sqlitePackageDir,
                nodeArchitecture: architecture.nodeArchitecture,
                environment,
            });
            await assertFileExists(nativeBindingPath, sqlitePackageDir);

            const slicePath = path.join(
                sliceRootDir,
                `better_sqlite3-${architecture.machOArchitecture}.node`,
            );
            await copyFile(nativeBindingPath, slicePath);
            slices.push({
                ...architecture,
                path: slicePath,
            });
        }

        // Assemble the canonical package binding only after both builds succeed.
        await universalAssembler({
            slices,
            outputPath: nativeBindingPath,
            environment,
        });
    } finally {
        await rm(sliceRootDir, { recursive: true, force: true });
    }
}

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

function runPackageInstall({ packageDir, nodeArchitecture, environment }) {
    const yarnBinary = process.platform === "win32" ? "yarn.cmd" : "yarn";
    const result = spawnSync(yarnBinary, ["run", "install"], {
        cwd: packageDir,
        env: {
            ...environment,
            npm_config_arch: nodeArchitecture,
            npm_config_target_arch: nodeArchitecture,
            npm_config_build_from_source: "true",
        },
        stdio: "inherit",
    });

    assertCommandSucceeded(result, `${sqlitePackageName} native build`);
}

function assembleUniversalMacOSBinding({ slices, outputPath, environment }) {
    const createResult = spawnSync(
        LIPO_COMMAND,
        [
            "-create",
            ...slices.map((slice) => slice.path),
            "-output",
            outputPath,
        ],
        { env: environment, stdio: "inherit" },
    );
    assertCommandSucceeded(createResult, "Universal SQLite binding assembly");

    const verifyResult = spawnSync(
        LIPO_COMMAND,
        createLipoVerifyArchitectureArguments(
            outputPath,
            slices.map(({ machOArchitecture }) => machOArchitecture),
        ),
        { env: environment, stdio: "inherit" },
    );
    assertCommandSucceeded(
        verifyResult,
        "Universal SQLite binding verification",
    );
}

async function isNativeBindingCompatible({
    nativeBindingPath,
    buildMetadataPath,
    expectedBuildMetadata,
    nodeTarget,
    platform,
    arch,
    environment,
}) {
    if (!(await pathExists(nativeBindingPath))) {
        return false;
    }
    const actualBuildMetadata = await readJsonIfPresent(buildMetadataPath);
    if (!isDeepStrictEqual(actualBuildMetadata, expectedBuildMetadata)) {
        return false;
    }

    if (
        platform === "darwin" &&
        [
            DESKTOP_NODE_DIST_TARGET.DarwinArm64,
            DESKTOP_NODE_DIST_TARGET.DarwinX64,
            DESKTOP_NODE_DIST_TARGET.DarwinUniversal,
        ].includes(nodeTarget)
    ) {
        const result = spawnSync(
            LIPO_COMMAND,
            createLipoVerifyArchitectureArguments(
                nativeBindingPath,
                getMacOSMachOArchitectures(nodeTarget),
            ),
            { env: environment, stdio: "ignore" },
        );
        if (result.error) {
            throw result.error;
        }
        return result.status === 0;
    }

    return nodeTarget === inferDesktopNodeDistTarget(platform, arch);
}

// Places the input before lipo's variadic architecture operands.
export function createLipoVerifyArchitectureArguments(
    inputPath,
    architectures,
) {
    return [inputPath, LIPO_VERIFY_ARCH_COMMAND, ...architectures];
}

async function readJsonIfPresent(filePath) {
    try {
        return JSON.parse(await readFile(filePath, "utf8"));
    } catch {
        return undefined;
    }
}

function assertCommandSucceeded(result, description) {
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`${description} failed with status ${result.status}`);
    }
}

async function assertDirectoryExists(dirPath) {
    try {
        await access(dirPath, fsConstants.R_OK);
    } catch {
        throw new Error(`Missing required directory: ${dirPath}`);
    }
}

async function assertFileExists(filePath, rootDir) {
    try {
        await access(filePath, fsConstants.R_OK);
    } catch {
        throw new Error(
            `Missing native binding: ${path.relative(rootDir, filePath)}`,
        );
    }
}

async function pathExists(targetPath) {
    try {
        await access(targetPath, fsConstants.R_OK);
        return true;
    } catch {
        return false;
    }
}

function parseBuildArguments(argv) {
    const unsupportedArguments = argv.filter(
        (argument) => argument !== BUILD_IF_NEEDED_ARGUMENT,
    );
    if (unsupportedArguments.length > 0) {
        throw new Error(
            `Usage: yarn build:sqlite-native [${BUILD_IF_NEEDED_ARGUMENT}]`,
        );
    }
    return {
        buildIfNeeded: argv.includes(BUILD_IF_NEEDED_ARGUMENT),
    };
}

const isMainModule =
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMainModule) {
    await buildSqliteNativeBinding(parseBuildArguments(process.argv.slice(2)));
}
