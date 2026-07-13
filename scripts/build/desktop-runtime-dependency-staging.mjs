import {
    chmod,
    lstat,
    mkdir,
    readdir,
    readFile,
    rm,
    writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import {
    DESKTOP_RUNTIME_DEPENDENCY_ROOTS,
    DESKTOP_RUNTIME_NODE_MODULES_DIRECTORY_NAME,
    FORBIDDEN_DESKTOP_RUNTIME_PNP_PATHS,
    getDesktopRuntimeDependencyPackageNames,
    getDesktopRuntimePackageFileSelection,
    getDesktopRuntimePackageSourceIssuer,
} from "./native-runtime-dependencies.mjs";
import {
    RUNTIME_BUILD_PROFILE,
    RUNTIME_BUILD_PROFILE_MARKER_FILE_NAME,
    parseRuntimeBuildProfileMarker,
} from "./runtime-build-profile.mjs";

const moduleRequire = createRequire(import.meta.url);

// Materializes only reviewed native package runtime files beside each artifact group.
export async function stageDesktopRuntimeDependencies({
    rootDir,
    destinationRootDir,
    nodeTarget,
    hostArch = process.arch,
    pnpApi = loadPnpApi(),
}) {
    await assertDesktopRuntimeBuildProfileMarkers(destinationRootDir);

    const packageSources = new Map();
    const resolvingPackageNames = new Set();

    const resolvePackageSource = async (packageName, runtime) => {
        const cacheKey = `${runtime.directoryName}\0${packageName}`;
        const cached = packageSources.get(cacheKey);
        if (cached) return cached;
        if (resolvingPackageNames.has(cacheKey)) {
            throw new Error(
                `Desktop runtime package resolution cycle: ${runtime.directoryName}/${packageName}`,
            );
        }

        resolvingPackageNames.add(cacheKey);
        try {
            const issuer = getDesktopRuntimePackageSourceIssuer(
                packageName,
                runtime,
            );
            const issuerPath = issuer.workspaceRelativePath
                ? path.join(rootDir, issuer.workspaceRelativePath)
                : path.join(
                      await resolvePackageSource(issuer.packageName, runtime),
                      "package.json",
                  );
            const sourceRoot = pnpApi.resolveToUnqualified(
                packageName,
                issuerPath,
            );
            if (!sourceRoot) {
                throw new Error(
                    `Yarn PnP did not resolve desktop runtime package ${packageName} from ${issuerPath}.`,
                );
            }
            await assertDirectoryWithoutSymlink(
                sourceRoot,
                `Locked desktop runtime package ${packageName}`,
            );
            packageSources.set(cacheKey, sourceRoot);
            return sourceRoot;
        } finally {
            resolvingPackageNames.delete(cacheKey);
        }
    };

    for (const runtime of Object.values(DESKTOP_RUNTIME_DEPENDENCY_ROOTS)) {
        await assertRegularFileWithoutSymlink(
            path.join(
                destinationRootDir,
                runtime.directoryName,
                runtime.issuerRelativePath,
            ),
            `${runtime.directoryName} desktop runtime artifact`,
        );
        const nodeModulesDir = path.join(
            destinationRootDir,
            runtime.directoryName,
            DESKTOP_RUNTIME_NODE_MODULES_DIRECTORY_NAME,
        );
        await rm(nodeModulesDir, { recursive: true, force: true });
        await mkdir(nodeModulesDir, { recursive: true });
        const expectedRelativePaths = new Set();
        const packageNames = getDesktopRuntimeDependencyPackageNames(
            runtime,
            nodeTarget,
            hostArch,
        );

        for (const packageName of packageNames) {
            const sourceRoot = await resolvePackageSource(packageName, runtime);
            const packageDestinationRelativePath = packageName
                .split("/")
                .join(path.sep);
            const destinationRoot = path.join(
                nodeModulesDir,
                packageDestinationRelativePath,
            );
            const copiedPackagePaths = await copyReviewedPackageFiles({
                sourceRoot,
                destinationRoot,
                selection: getDesktopRuntimePackageFileSelection(packageName),
                packageName,
            });
            for (const copiedPath of copiedPackagePaths) {
                expectedRelativePaths.add(
                    toPortableRelativePath(
                        path.join(packageDestinationRelativePath, copiedPath),
                    ),
                );
            }
        }

        await validateExactRegularFileTree({
            rootDir: nodeModulesDir,
            expectedRelativePaths,
            label: `${runtime.directoryName} desktop runtime dependencies`,
        });
    }
}

// Refuses to stage full runtime artifacts that can contain desktop-excluded modules.
export async function assertDesktopRuntimeBuildProfileMarkers(runtimeRootDir) {
    for (const runtime of Object.values(DESKTOP_RUNTIME_DEPENDENCY_ROOTS)) {
        const markerPath = path.join(
            runtimeRootDir,
            runtime.directoryName,
            "dist-desktop",
            RUNTIME_BUILD_PROFILE_MARKER_FILE_NAME,
        );
        const description = `${runtime.directoryName} runtime build profile marker`;
        await assertRegularFileWithoutSymlink(markerPath, description);
        const profile = parseRuntimeBuildProfileMarker(
            await readFile(markerPath, "utf8"),
            description,
        );
        if (profile !== RUNTIME_BUILD_PROFILE.DESKTOP) {
            throw new Error(
                `Refusing to stage ${runtime.directoryName} runtime artifacts built with the ${profile} profile; expected ${RUNTIME_BUILD_PROFILE.DESKTOP}.`,
            );
        }
    }
}

// Copies a package through an explicit file selection and rejects links or special files.
export async function copyReviewedPackageFiles({
    sourceRoot,
    destinationRoot,
    selection,
    packageName,
}) {
    const selectedFiles = new Map();

    for (const relativePath of selection.required) {
        await collectReviewedPath({
            sourceRoot,
            relativePath,
            required: true,
            selectedFiles,
            packageName,
        });
    }
    for (const relativePath of selection.optional) {
        await collectReviewedPath({
            sourceRoot,
            relativePath,
            required: false,
            selectedFiles,
            packageName,
        });
    }

    const selectedRelativePaths = [...selectedFiles.keys()].sort(
        (left, right) => left.localeCompare(right),
    );
    if (selectedRelativePaths.length === 0) {
        throw new Error(
            `Reviewed desktop runtime package selection is empty: ${packageName}`,
        );
    }

    for (const relativePath of selectedRelativePaths) {
        const sourceFile = selectedFiles.get(relativePath);
        const destinationFile = path.join(destinationRoot, relativePath);
        await mkdir(path.dirname(destinationFile), { recursive: true });
        await writeFile(destinationFile, await readFile(sourceFile.path));
        await chmod(destinationFile, sourceFile.mode & 0o777);
    }

    return selectedRelativePaths;
}

// Verifies a staged tree contains exactly the reviewed regular files and no links.
export async function validateExactRegularFileTree({
    rootDir,
    expectedRelativePaths,
    label,
}) {
    const actualRelativePaths = await collectRegularFileTree(rootDir, label);
    const expected = new Set(
        [...expectedRelativePaths].map(toPortableRelativePath),
    );
    const missing = [...expected]
        .filter((relativePath) => !actualRelativePaths.has(relativePath))
        .sort();
    const unexpected = [...actualRelativePaths]
        .filter((relativePath) => !expected.has(relativePath))
        .sort();

    if (missing.length > 0 || unexpected.length > 0) {
        throw new Error(
            `${label} differ from the reviewed file set. Missing (${missing.length}): ${formatPaths(missing)}; unexpected (${unexpected.length}): ${formatPaths(unexpected)}.`,
        );
    }
}

// Rejects project-level Yarn runtime data in the user-facing desktop resource tree.
export async function assertNoForbiddenDesktopRuntimePaths(resourcesRootDir) {
    for (const relativePath of FORBIDDEN_DESKTOP_RUNTIME_PNP_PATHS) {
        const candidate = path.join(resourcesRootDir, relativePath);
        const metadata = await lstatIfPresent(candidate);
        if (metadata) {
            throw new Error(
                `Forbidden Yarn project runtime path was staged: ${candidate}`,
            );
        }
    }
}

async function collectReviewedPath({
    sourceRoot,
    relativePath,
    required,
    selectedFiles,
    packageName,
}) {
    const normalizedRelativePath = validatePackageRelativePath(relativePath);
    const sourcePath = path.join(sourceRoot, normalizedRelativePath);
    const metadata = await lstatIfPresent(sourcePath);
    if (!metadata) {
        if (!required) return;
        throw new Error(
            `Missing reviewed runtime path for ${packageName}: ${normalizedRelativePath}`,
        );
    }
    await collectReviewedEntry({
        sourceRoot,
        sourcePath,
        metadata,
        selectedFiles,
        packageName,
    });
}

async function collectReviewedEntry({
    sourceRoot,
    sourcePath,
    metadata,
    selectedFiles,
    packageName,
}) {
    const relativePath = path.relative(sourceRoot, sourcePath);
    if (metadata.isSymbolicLink()) {
        throw new Error(
            `Symlink is forbidden in reviewed desktop runtime package ${packageName}: ${relativePath}`,
        );
    }
    if (metadata.isFile()) {
        const portablePath = toPortableRelativePath(relativePath);
        selectedFiles.set(portablePath, {
            path: sourcePath,
            mode: metadata.mode,
        });
        return;
    }
    if (!metadata.isDirectory()) {
        throw new Error(
            `Special file is forbidden in reviewed desktop runtime package ${packageName}: ${relativePath}`,
        );
    }

    const entries = await readdir(sourcePath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
        const entryPath = path.join(sourcePath, entry.name);
        await collectReviewedEntry({
            sourceRoot,
            sourcePath: entryPath,
            metadata: await lstat(entryPath),
            selectedFiles,
            packageName,
        });
    }
}

async function collectRegularFileTree(rootDir, label) {
    await assertDirectoryWithoutSymlink(rootDir, label);
    const files = new Set();

    const visit = async (directory) => {
        const entries = await readdir(directory, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            const entryPath = path.join(directory, entry.name);
            const metadata = await lstat(entryPath);
            const relativePath = path.relative(rootDir, entryPath);
            if (metadata.isSymbolicLink()) {
                throw new Error(
                    `Symlink is forbidden in ${label}: ${relativePath}`,
                );
            }
            if (metadata.isDirectory()) {
                await visit(entryPath);
                continue;
            }
            if (!metadata.isFile()) {
                throw new Error(
                    `Special file is forbidden in ${label}: ${relativePath}`,
                );
            }
            files.add(toPortableRelativePath(relativePath));
        }
    };

    await visit(rootDir);
    return files;
}

async function assertDirectoryWithoutSymlink(directoryPath, label) {
    const metadata = await lstatIfPresent(directoryPath);
    if (!metadata) {
        throw new Error(`${label} is unavailable: ${directoryPath}`);
    }
    if (metadata.isSymbolicLink()) {
        throw new Error(`${label} must not be a symlink: ${directoryPath}`);
    }
    if (!metadata.isDirectory()) {
        throw new Error(`${label} is not a directory: ${directoryPath}`);
    }
}

async function assertRegularFileWithoutSymlink(filePath, label) {
    const metadata = await lstatIfPresent(filePath);
    if (!metadata) {
        throw new Error(`${label} is unavailable: ${filePath}`);
    }
    if (metadata.isSymbolicLink()) {
        throw new Error(`${label} must not be a symlink: ${filePath}`);
    }
    if (!metadata.isFile()) {
        throw new Error(`${label} is not a regular file: ${filePath}`);
    }
}

function validatePackageRelativePath(relativePath) {
    if (
        typeof relativePath !== "string" ||
        relativePath.length === 0 ||
        path.isAbsolute(relativePath)
    ) {
        throw new Error(`Invalid reviewed package path: ${relativePath}`);
    }
    const normalized = path.normalize(relativePath);
    if (
        normalized === ".." ||
        normalized.startsWith(`..${path.sep}`) ||
        normalized.includes(`${path.sep}..${path.sep}`)
    ) {
        throw new Error(
            `Reviewed package path escapes its package: ${relativePath}`,
        );
    }
    return normalized;
}

function loadPnpApi() {
    try {
        return moduleRequire("pnpapi");
    } catch (error) {
        throw new Error(
            `Desktop runtime dependency staging requires the locked Yarn PnP install. Run this script through a Yarn project command. ${error}`,
        );
    }
}

async function lstatIfPresent(targetPath) {
    try {
        return await lstat(targetPath);
    } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
    }
}

function toPortableRelativePath(relativePath) {
    return relativePath.split(path.sep).join("/");
}

function formatPaths(paths) {
    return paths.length === 0 ? "none" : paths.slice(0, 8).join(", ");
}
