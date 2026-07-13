// Native packages left external so their package-local loaders can load reviewed native files.
export const NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES = Object.freeze({
    BetterSqlite3: "better-sqlite3",
    Sharp: "sharp",
});

// Transitive runtime packages required by the two external native packages.
export const DESKTOP_RUNTIME_TRANSITIVE_PACKAGE_NAMES = Object.freeze({
    Bindings: "bindings",
    FileUriToPath: "file-uri-to-path",
    ImgColour: "@img/colour",
    DetectLibc: "detect-libc",
    Semver: "semver",
});

// Desktop runtime directories that own isolated Node dependency trees.
export const DESKTOP_RUNTIME_DEPENDENCY_ROOTS = Object.freeze({
    Backend: Object.freeze({
        directoryName: "backend",
        issuerRelativePath: "dist-desktop/server.mjs",
        includeSharp: true,
    }),
    Indexer: Object.freeze({
        directoryName: "indexer",
        issuerRelativePath: "dist-desktop/bootstrap-worker.mjs",
        includeSharp: true,
    }),
    Trading: Object.freeze({
        directoryName: "trading",
        issuerRelativePath: "dist-desktop/bidding-bot-runtime.mjs",
        includeSharp: false,
    }),
});

// Standard Node dependency directory materialized beside each runtime artifact group.
export const DESKTOP_RUNTIME_NODE_MODULES_DIRECTORY_NAME = "node_modules";

// Yarn project files are build inputs only and must never enter desktop runtime resources.
export const FORBIDDEN_DESKTOP_RUNTIME_PNP_PATHS = Object.freeze([
    ".yarn",
    ".pnp.cjs",
    ".pnp.data.json",
    ".pnp.loader.mjs",
]);

// better-sqlite3 writes this native binding after its trusted package-local install step.
export const BETTER_SQLITE3_NATIVE_BINDING_RELATIVE_PATH =
    "build/Release/better_sqlite3.node";

// Reviewed desktop runtime distribution targets shared by staging and release builds.
export const DESKTOP_NODE_DIST_TARGET = Object.freeze({
    LinuxX64: "linux-x64",
    LinuxArm64: "linux-arm64",
    DarwinX64: "darwin-x64",
    DarwinArm64: "darwin-arm64",
    DarwinUniversal: "darwin-universal",
    WindowsX64: "win-x64",
    WindowsArm64: "win-arm64",
});

const SQLITE_RUNTIME_PACKAGE_NAMES = Object.freeze([
    NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.BetterSqlite3,
    DESKTOP_RUNTIME_TRANSITIVE_PACKAGE_NAMES.Bindings,
    DESKTOP_RUNTIME_TRANSITIVE_PACKAGE_NAMES.FileUriToPath,
]);

const SHARP_COMMON_RUNTIME_PACKAGE_NAMES = Object.freeze([
    NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.Sharp,
    DESKTOP_RUNTIME_TRANSITIVE_PACKAGE_NAMES.ImgColour,
    DESKTOP_RUNTIME_TRANSITIVE_PACKAGE_NAMES.DetectLibc,
    DESKTOP_RUNTIME_TRANSITIVE_PACKAGE_NAMES.Semver,
]);

// Sharp publishes native addon and libvips packages separately for each supported target.
export const SHARP_RUNTIME_PACKAGES_BY_NODE_TARGET = Object.freeze({
    [DESKTOP_NODE_DIST_TARGET.LinuxX64]: Object.freeze([
        "@img/sharp-linux-x64",
        "@img/sharp-libvips-linux-x64",
    ]),
    [DESKTOP_NODE_DIST_TARGET.LinuxArm64]: Object.freeze([
        "@img/sharp-linux-arm64",
        "@img/sharp-libvips-linux-arm64",
    ]),
    [DESKTOP_NODE_DIST_TARGET.DarwinX64]: Object.freeze([
        "@img/sharp-darwin-x64",
        "@img/sharp-libvips-darwin-x64",
    ]),
    [DESKTOP_NODE_DIST_TARGET.DarwinArm64]: Object.freeze([
        "@img/sharp-darwin-arm64",
        "@img/sharp-libvips-darwin-arm64",
    ]),
    [DESKTOP_NODE_DIST_TARGET.WindowsX64]: Object.freeze([
        "@img/sharp-win32-x64",
    ]),
    [DESKTOP_NODE_DIST_TARGET.WindowsArm64]: Object.freeze([
        "@img/sharp-win32-arm64",
    ]),
});

const PACKAGE_SOURCE_ISSUERS = Object.freeze({
    [DESKTOP_RUNTIME_TRANSITIVE_PACKAGE_NAMES.Bindings]: Object.freeze({
        packageName: NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.BetterSqlite3,
    }),
    [DESKTOP_RUNTIME_TRANSITIVE_PACKAGE_NAMES.FileUriToPath]: Object.freeze({
        packageName: DESKTOP_RUNTIME_TRANSITIVE_PACKAGE_NAMES.Bindings,
    }),
    [DESKTOP_RUNTIME_TRANSITIVE_PACKAGE_NAMES.ImgColour]: Object.freeze({
        packageName: NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.Sharp,
    }),
    [DESKTOP_RUNTIME_TRANSITIVE_PACKAGE_NAMES.DetectLibc]: Object.freeze({
        packageName: NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.Sharp,
    }),
    [DESKTOP_RUNTIME_TRANSITIVE_PACKAGE_NAMES.Semver]: Object.freeze({
        packageName: NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.Sharp,
    }),
});

const FIXED_PACKAGE_FILE_SELECTIONS = Object.freeze({
    [NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.BetterSqlite3]: Object.freeze({
        required: Object.freeze([
            "package.json",
            "LICENSE",
            "lib",
            BETTER_SQLITE3_NATIVE_BINDING_RELATIVE_PATH,
        ]),
        optional: Object.freeze([]),
    }),
    [NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.Sharp]: Object.freeze({
        required: Object.freeze(["package.json", "LICENSE", "lib"]),
        optional: Object.freeze([]),
    }),
    [DESKTOP_RUNTIME_TRANSITIVE_PACKAGE_NAMES.Bindings]: Object.freeze({
        required: Object.freeze(["package.json", "LICENSE.md", "bindings.js"]),
        optional: Object.freeze([]),
    }),
    [DESKTOP_RUNTIME_TRANSITIVE_PACKAGE_NAMES.FileUriToPath]: Object.freeze({
        required: Object.freeze(["package.json", "LICENSE", "index.js"]),
        optional: Object.freeze([]),
    }),
    [DESKTOP_RUNTIME_TRANSITIVE_PACKAGE_NAMES.ImgColour]: Object.freeze({
        required: Object.freeze([
            "package.json",
            "LICENSE.md",
            "index.cjs",
            "color.cjs",
        ]),
        optional: Object.freeze([]),
    }),
    [DESKTOP_RUNTIME_TRANSITIVE_PACKAGE_NAMES.DetectLibc]: Object.freeze({
        required: Object.freeze(["package.json", "LICENSE", "lib"]),
        optional: Object.freeze([]),
    }),
    [DESKTOP_RUNTIME_TRANSITIVE_PACKAGE_NAMES.Semver]: Object.freeze({
        required: Object.freeze([
            "package.json",
            "LICENSE",
            "index.js",
            "classes",
            "functions",
            "internal",
            "ranges",
        ]),
        optional: Object.freeze([]),
    }),
});

const SHARP_TARGET_PACKAGE_FILE_SELECTION = Object.freeze({
    required: Object.freeze(["package.json", "lib"]),
    optional: Object.freeze([
        "LICENSE",
        "LICENSE.md",
        "README.md",
        "versions.json",
    ]),
});

// esbuild leaves these packages as runtime imports resolved from isolated node_modules trees.
export const NATIVE_RUNTIME_EXTERNAL_PACKAGES = Object.freeze(
    Object.values(NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES),
);

// Maps the host platform to the reviewed native dependency distribution target.
export function inferDesktopNodeDistTarget(platform, arch) {
    if (platform === "linux") {
        if (arch === "x64") return DESKTOP_NODE_DIST_TARGET.LinuxX64;
        if (arch === "arm64") return DESKTOP_NODE_DIST_TARGET.LinuxArm64;
    }
    if (platform === "darwin") {
        if (arch === "x64") return DESKTOP_NODE_DIST_TARGET.DarwinX64;
        if (arch === "arm64") return DESKTOP_NODE_DIST_TARGET.DarwinArm64;
    }
    if (platform === "win32") {
        if (arch === "x64") return DESKTOP_NODE_DIST_TARGET.WindowsX64;
        if (arch === "arm64") return DESKTOP_NODE_DIST_TARGET.WindowsArm64;
    }
    throw new Error(
        `Unsupported platform/arch for automatic desktop Node target: ${platform}/${arch}. Set DESKTOP_NODE_DIST_TARGET explicitly.`,
    );
}

// Returns the complete reviewed package set for one staged runtime.
export function getDesktopRuntimeDependencyPackageNames(
    runtime,
    nodeTarget,
    hostArch = process.arch,
) {
    const packageNames = [...SQLITE_RUNTIME_PACKAGE_NAMES];
    if (runtime.includeSharp) {
        packageNames.push(
            ...SHARP_COMMON_RUNTIME_PACKAGE_NAMES,
            ...getSharpRuntimePackageNames(nodeTarget, hostArch),
        );
    }
    return packageNames;
}

// Resolves the reviewed Sharp addon/libvips package names for a Node distribution target.
export function getSharpRuntimePackageNames(
    nodeTarget,
    hostArch = process.arch,
) {
    // The current universal macOS lane builds native addons only for its host architecture.
    const resolvedTarget =
        nodeTarget === DESKTOP_NODE_DIST_TARGET.DarwinUniversal
            ? resolveDarwinHostNodeTarget(hostArch)
            : nodeTarget;
    const packageNames = SHARP_RUNTIME_PACKAGES_BY_NODE_TARGET[resolvedTarget];
    if (!packageNames) {
        throw new Error(
            `Unsupported DESKTOP_NODE_DIST_TARGET "${nodeTarget}" for Sharp runtime packages.`,
        );
    }
    return [...packageNames];
}

function resolveDarwinHostNodeTarget(hostArch) {
    if (hostArch === "x64") return DESKTOP_NODE_DIST_TARGET.DarwinX64;
    if (hostArch === "arm64") return DESKTOP_NODE_DIST_TARGET.DarwinArm64;
    throw new Error(
        `Unsupported host architecture "${hostArch}" for ${DESKTOP_NODE_DIST_TARGET.DarwinUniversal} native dependency staging.`,
    );
}

// Describes which locked package context owns resolution of a staged package.
export function getDesktopRuntimePackageSourceIssuer(packageName, runtime) {
    if (
        packageName === NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.BetterSqlite3 ||
        packageName === NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.Sharp
    ) {
        const resolvedRuntime = requireDesktopRuntimeDependencyRoot(runtime);
        if (
            packageName === NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.Sharp &&
            !resolvedRuntime.includeSharp
        ) {
            throw new Error(
                `${resolvedRuntime.directoryName} does not own the Sharp desktop runtime dependency.`,
            );
        }
        return Object.freeze({
            workspaceRelativePath: `${resolvedRuntime.directoryName}/package.json`,
        });
    }

    const fixedIssuer = PACKAGE_SOURCE_ISSUERS[packageName];
    if (fixedIssuer) return fixedIssuer;

    if (isSharpTargetPackageName(packageName)) {
        return Object.freeze({
            packageName: NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.Sharp,
        });
    }
    throw new Error(`Unreviewed desktop runtime package: ${packageName}`);
}

function requireDesktopRuntimeDependencyRoot(runtime) {
    if (!Object.values(DESKTOP_RUNTIME_DEPENDENCY_ROOTS).includes(runtime)) {
        throw new Error("Desktop runtime dependency root is required.");
    }
    return runtime;
}

// Returns the exact package-local paths allowed into desktop runtime resources.
export function getDesktopRuntimePackageFileSelection(packageName) {
    const fixedSelection = FIXED_PACKAGE_FILE_SELECTIONS[packageName];
    if (fixedSelection) return fixedSelection;
    if (isSharpTargetPackageName(packageName)) {
        return SHARP_TARGET_PACKAGE_FILE_SELECTION;
    }
    throw new Error(`Unreviewed desktop runtime package: ${packageName}`);
}

function isSharpTargetPackageName(packageName) {
    return Object.values(SHARP_RUNTIME_PACKAGES_BY_NODE_TARGET).some(
        (packageNames) => packageNames.includes(packageName),
    );
}
