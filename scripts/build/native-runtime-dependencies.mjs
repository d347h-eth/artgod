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

// Rust/Tauri targets that select a reviewed desktop runtime distribution.
export const DESKTOP_RUST_TARGET = Object.freeze({
    LinuxX64: "x86_64-unknown-linux-gnu",
    LinuxArm64: "aarch64-unknown-linux-gnu",
    DarwinX64: "x86_64-apple-darwin",
    DarwinArm64: "aarch64-apple-darwin",
    DarwinUniversal: "universal-apple-darwin",
    WindowsX64: "x86_64-pc-windows-msvc",
    WindowsArm64: "aarch64-pc-windows-msvc",
});

// Environment keys that carry desktop build-target selection across Tauri hooks.
export const DESKTOP_BUILD_TARGET_ENV_KEYS = Object.freeze({
    NodeDistributionTarget: "DESKTOP_NODE_DIST_TARGET",
    NatsDistributionTarget: "DESKTOP_NATS_DIST_TARGET",
    TauriTargetTriple: "TAURI_ENV_TARGET_TRIPLE",
    CargoBuildTarget: "CARGO_BUILD_TARGET",
    RustTarget: "TARGET",
});

// Node architecture names accepted by native package build tooling.
export const DESKTOP_NODE_ARCHITECTURE = Object.freeze({
    X64: "x64",
    Arm64: "arm64",
});

// Mach-O architecture names reported and accepted by Apple's lipo tool.
export const MACOS_MACH_O_ARCHITECTURE = Object.freeze({
    X64: "x86_64",
    Arm64: DESKTOP_NODE_ARCHITECTURE.Arm64,
});

// Native architecture slices required by one universal macOS release.
export const MACOS_UNIVERSAL_NATIVE_ARCHITECTURES = Object.freeze([
    Object.freeze({
        nodeArchitecture: DESKTOP_NODE_ARCHITECTURE.Arm64,
        machOArchitecture: MACOS_MACH_O_ARCHITECTURE.Arm64,
        nodeTarget: DESKTOP_NODE_DIST_TARGET.DarwinArm64,
        rustTarget: DESKTOP_RUST_TARGET.DarwinArm64,
    }),
    Object.freeze({
        nodeArchitecture: DESKTOP_NODE_ARCHITECTURE.X64,
        machOArchitecture: MACOS_MACH_O_ARCHITECTURE.X64,
        nodeTarget: DESKTOP_NODE_DIST_TARGET.DarwinX64,
        rustTarget: DESKTOP_RUST_TARGET.DarwinX64,
    }),
]);

const DESKTOP_NODE_DIST_TARGET_BY_RUST_TARGET = Object.freeze({
    [DESKTOP_RUST_TARGET.LinuxX64]: DESKTOP_NODE_DIST_TARGET.LinuxX64,
    [DESKTOP_RUST_TARGET.LinuxArm64]: DESKTOP_NODE_DIST_TARGET.LinuxArm64,
    [DESKTOP_RUST_TARGET.DarwinX64]: DESKTOP_NODE_DIST_TARGET.DarwinX64,
    [DESKTOP_RUST_TARGET.DarwinArm64]: DESKTOP_NODE_DIST_TARGET.DarwinArm64,
    [DESKTOP_RUST_TARGET.DarwinUniversal]:
        DESKTOP_NODE_DIST_TARGET.DarwinUniversal,
    [DESKTOP_RUST_TARGET.WindowsX64]: DESKTOP_NODE_DIST_TARGET.WindowsX64,
    [DESKTOP_RUST_TARGET.WindowsArm64]: DESKTOP_NODE_DIST_TARGET.WindowsArm64,
});

const NODE_ARCHITECTURE_BY_DESKTOP_NODE_DIST_TARGET = Object.freeze({
    [DESKTOP_NODE_DIST_TARGET.LinuxX64]: DESKTOP_NODE_ARCHITECTURE.X64,
    [DESKTOP_NODE_DIST_TARGET.LinuxArm64]: DESKTOP_NODE_ARCHITECTURE.Arm64,
    [DESKTOP_NODE_DIST_TARGET.DarwinX64]: DESKTOP_NODE_ARCHITECTURE.X64,
    [DESKTOP_NODE_DIST_TARGET.DarwinArm64]: DESKTOP_NODE_ARCHITECTURE.Arm64,
    [DESKTOP_NODE_DIST_TARGET.WindowsX64]: DESKTOP_NODE_ARCHITECTURE.X64,
    [DESKTOP_NODE_DIST_TARGET.WindowsArm64]: DESKTOP_NODE_ARCHITECTURE.Arm64,
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
        if (arch === DESKTOP_NODE_ARCHITECTURE.X64)
            return DESKTOP_NODE_DIST_TARGET.LinuxX64;
        if (arch === DESKTOP_NODE_ARCHITECTURE.Arm64)
            return DESKTOP_NODE_DIST_TARGET.LinuxArm64;
    }
    if (platform === "darwin") {
        if (arch === DESKTOP_NODE_ARCHITECTURE.X64)
            return DESKTOP_NODE_DIST_TARGET.DarwinX64;
        if (arch === DESKTOP_NODE_ARCHITECTURE.Arm64)
            return DESKTOP_NODE_DIST_TARGET.DarwinArm64;
    }
    if (platform === "win32") {
        if (arch === DESKTOP_NODE_ARCHITECTURE.X64)
            return DESKTOP_NODE_DIST_TARGET.WindowsX64;
        if (arch === DESKTOP_NODE_ARCHITECTURE.Arm64)
            return DESKTOP_NODE_DIST_TARGET.WindowsArm64;
    }
    throw new Error(
        `Unsupported platform/arch for automatic desktop Node target: ${platform}/${arch}. Set ${DESKTOP_BUILD_TARGET_ENV_KEYS.NodeDistributionTarget} explicitly.`,
    );
}

// Resolves matching explicit and Tauri/Cargo targets before falling back to the host.
export function resolveDesktopDistributionTarget({
    configuredTarget,
    rustTargetTriple,
    platform = process.platform,
    arch = process.arch,
}) {
    const explicitTarget = configuredTarget?.trim();
    if (
        explicitTarget &&
        !Object.values(DESKTOP_NODE_DIST_TARGET).includes(explicitTarget)
    ) {
        throw new Error(
            `Unsupported desktop distribution target "${explicitTarget}".`,
        );
    }

    const normalizedRustTarget = rustTargetTriple?.trim();
    let resolvedRustTarget;
    if (normalizedRustTarget) {
        resolvedRustTarget =
            DESKTOP_NODE_DIST_TARGET_BY_RUST_TARGET[normalizedRustTarget];
        if (!resolvedRustTarget) {
            throw new Error(
                `Unsupported Rust/Tauri desktop target "${normalizedRustTarget}".`,
            );
        }
    }

    if (
        explicitTarget &&
        resolvedRustTarget &&
        explicitTarget !== resolvedRustTarget
    ) {
        throw new Error(
            `Desktop distribution target "${explicitTarget}" conflicts with Rust/Tauri target "${normalizedRustTarget}" (${resolvedRustTarget}).`,
        );
    }

    if (explicitTarget) return explicitTarget;
    if (resolvedRustTarget) return resolvedRustTarget;
    return inferDesktopNodeDistTarget(platform, arch);
}

// Resolves one authoritative Tauri/Cargo target and rejects contradictory context.
export function resolveDesktopRustTargetFromEnvironment(
    environment = process.env,
) {
    const tauriTarget =
        environment[DESKTOP_BUILD_TARGET_ENV_KEYS.TauriTargetTriple]?.trim();
    const cargoTarget =
        environment[DESKTOP_BUILD_TARGET_ENV_KEYS.CargoBuildTarget]?.trim();
    if (tauriTarget && cargoTarget && tauriTarget !== cargoTarget) {
        throw new Error(
            `${DESKTOP_BUILD_TARGET_ENV_KEYS.TauriTargetTriple} "${tauriTarget}" conflicts with ${DESKTOP_BUILD_TARGET_ENV_KEYS.CargoBuildTarget} "${cargoTarget}".`,
        );
    }
    return tauriTarget || cargoTarget;
}

// Resolves one runtime distribution target from the shared build environment.
export function resolveDesktopDistributionTargetFromEnvironment({
    environment = process.env,
    distributionTargetEnvKey,
    platform = process.platform,
    arch = process.arch,
}) {
    return resolveDesktopDistributionTarget({
        configuredTarget: environment[distributionTargetEnvKey],
        rustTargetTriple: resolveDesktopRustTargetFromEnvironment(environment),
        platform,
        arch,
    });
}

// Returns the Node build architectures required by one distribution target.
export function getDesktopNativeNodeArchitectures(nodeTarget) {
    if (nodeTarget === DESKTOP_NODE_DIST_TARGET.DarwinUniversal) {
        return MACOS_UNIVERSAL_NATIVE_ARCHITECTURES.map(
            ({ nodeArchitecture }) => nodeArchitecture,
        );
    }

    const nodeArchitecture =
        NODE_ARCHITECTURE_BY_DESKTOP_NODE_DIST_TARGET[nodeTarget];
    if (!nodeArchitecture) {
        throw new Error(
            `Unsupported desktop distribution target "${nodeTarget}" for native builds.`,
        );
    }
    return [nodeArchitecture];
}

// Returns the Mach-O slice names required by one reviewed macOS target.
export function getMacOSMachOArchitectures(nodeTarget) {
    if (nodeTarget === DESKTOP_NODE_DIST_TARGET.DarwinUniversal) {
        return MACOS_UNIVERSAL_NATIVE_ARCHITECTURES.map(
            ({ machOArchitecture }) => machOArchitecture,
        );
    }

    const architecture = MACOS_UNIVERSAL_NATIVE_ARCHITECTURES.find(
        ({ nodeTarget: concreteTarget }) => concreteTarget === nodeTarget,
    );
    if (!architecture) {
        throw new Error(
            `Desktop distribution target "${nodeTarget}" is not a macOS target.`,
        );
    }
    return [architecture.machOArchitecture];
}

// Returns the complete reviewed package set for one staged runtime.
export function getDesktopRuntimeDependencyPackageNames(runtime, nodeTarget) {
    const packageNames = [...SQLITE_RUNTIME_PACKAGE_NAMES];
    if (runtime.includeSharp) {
        packageNames.push(
            ...SHARP_COMMON_RUNTIME_PACKAGE_NAMES,
            ...getSharpRuntimePackageNames(nodeTarget),
        );
    }
    return packageNames;
}

// Resolves the reviewed Sharp addon/libvips package names for a Node distribution target.
export function getSharpRuntimePackageNames(nodeTarget) {
    if (nodeTarget === DESKTOP_NODE_DIST_TARGET.DarwinUniversal) {
        return MACOS_UNIVERSAL_NATIVE_ARCHITECTURES.flatMap(
            ({ nodeTarget: concreteTarget }) =>
                SHARP_RUNTIME_PACKAGES_BY_NODE_TARGET[concreteTarget],
        );
    }

    const packageNames = SHARP_RUNTIME_PACKAGES_BY_NODE_TARGET[nodeTarget];
    if (!packageNames) {
        throw new Error(
            `Unsupported ${DESKTOP_BUILD_TARGET_ENV_KEYS.NodeDistributionTarget} "${nodeTarget}" for Sharp runtime packages.`,
        );
    }
    return [...packageNames];
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
