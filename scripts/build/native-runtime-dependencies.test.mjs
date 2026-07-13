import assert from "node:assert/strict";
import test from "node:test";
import {
    BETTER_SQLITE3_NATIVE_BINDING_RELATIVE_PATH,
    DESKTOP_BUILD_TARGET_ENV_KEYS,
    DESKTOP_NODE_ARCHITECTURE,
    DESKTOP_NODE_DIST_TARGET,
    DESKTOP_RUST_TARGET,
    DESKTOP_RUNTIME_DEPENDENCY_ROOTS,
    DESKTOP_RUNTIME_TRANSITIVE_PACKAGE_NAMES,
    MACOS_UNIVERSAL_NATIVE_ARCHITECTURES,
    NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES,
    getDesktopNativeNodeArchitectures,
    getDesktopRuntimeDependencyPackageNames,
    getDesktopRuntimePackageFileSelection,
    getDesktopRuntimePackageSourceIssuer,
    getSharpRuntimePackageNames,
    inferDesktopNodeDistTarget,
    resolveDesktopDistributionTarget,
    resolveDesktopDistributionTargetFromEnvironment,
} from "./native-runtime-dependencies.mjs";

test("trading receives only the better-sqlite3 runtime closure", () => {
    assert.deepEqual(
        getDesktopRuntimeDependencyPackageNames(
            DESKTOP_RUNTIME_DEPENDENCY_ROOTS.Trading,
            DESKTOP_NODE_DIST_TARGET.LinuxX64,
        ),
        [
            NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.BetterSqlite3,
            DESKTOP_RUNTIME_TRANSITIVE_PACKAGE_NAMES.Bindings,
            DESKTOP_RUNTIME_TRANSITIVE_PACKAGE_NAMES.FileUriToPath,
        ],
    );
});

test("backend and indexer receive the reviewed Sharp closure for Linux", () => {
    const expectedSharpPackages = [
        NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.Sharp,
        DESKTOP_RUNTIME_TRANSITIVE_PACKAGE_NAMES.ImgColour,
        DESKTOP_RUNTIME_TRANSITIVE_PACKAGE_NAMES.DetectLibc,
        DESKTOP_RUNTIME_TRANSITIVE_PACKAGE_NAMES.Semver,
        "@img/sharp-linux-x64",
        "@img/sharp-libvips-linux-x64",
    ];

    for (const runtime of [
        DESKTOP_RUNTIME_DEPENDENCY_ROOTS.Backend,
        DESKTOP_RUNTIME_DEPENDENCY_ROOTS.Indexer,
    ]) {
        assert.deepEqual(
            getDesktopRuntimeDependencyPackageNames(
                runtime,
                DESKTOP_NODE_DIST_TARGET.LinuxX64,
            ).slice(3),
            expectedSharpPackages,
        );
    }
});

test("darwin-universal stages both Sharp and libvips architecture packages", () => {
    assert.deepEqual(
        getSharpRuntimePackageNames(DESKTOP_NODE_DIST_TARGET.DarwinUniversal),
        [
            "@img/sharp-darwin-arm64",
            "@img/sharp-libvips-darwin-arm64",
            "@img/sharp-darwin-x64",
            "@img/sharp-libvips-darwin-x64",
        ],
    );
});

test("desktop targets require explicit config to match Tauri context", () => {
    assert.equal(
        resolveDesktopDistributionTarget({
            configuredTarget: DESKTOP_NODE_DIST_TARGET.DarwinUniversal,
            rustTargetTriple: DESKTOP_RUST_TARGET.DarwinUniversal,
            platform: "darwin",
            arch: DESKTOP_NODE_ARCHITECTURE.Arm64,
        }),
        DESKTOP_NODE_DIST_TARGET.DarwinUniversal,
    );
    assert.throws(
        () =>
            resolveDesktopDistributionTarget({
                configuredTarget: DESKTOP_NODE_DIST_TARGET.LinuxX64,
                rustTargetTriple: DESKTOP_RUST_TARGET.DarwinUniversal,
                platform: "darwin",
                arch: DESKTOP_NODE_ARCHITECTURE.Arm64,
            }),
        /conflicts with Rust\/Tauri target/,
    );
    assert.equal(
        resolveDesktopDistributionTarget({
            rustTargetTriple: DESKTOP_RUST_TARGET.DarwinUniversal,
            platform: "darwin",
            arch: DESKTOP_NODE_ARCHITECTURE.Arm64,
        }),
        DESKTOP_NODE_DIST_TARGET.DarwinUniversal,
    );
    assert.equal(
        resolveDesktopDistributionTarget({
            platform: "darwin",
            arch: DESKTOP_NODE_ARCHITECTURE.X64,
        }),
        DESKTOP_NODE_DIST_TARGET.DarwinX64,
    );
    assert.throws(
        () =>
            resolveDesktopDistributionTarget({
                rustTargetTriple: "unsupported-target",
                platform: "darwin",
                arch: DESKTOP_NODE_ARCHITECTURE.Arm64,
            }),
        /Unsupported Rust\/Tauri desktop target/,
    );
    assert.throws(
        () =>
            resolveDesktopDistributionTargetFromEnvironment({
                environment: {
                    [DESKTOP_BUILD_TARGET_ENV_KEYS.TauriTargetTriple]:
                        DESKTOP_RUST_TARGET.DarwinUniversal,
                    [DESKTOP_BUILD_TARGET_ENV_KEYS.CargoBuildTarget]:
                        DESKTOP_RUST_TARGET.DarwinArm64,
                },
                distributionTargetEnvKey:
                    DESKTOP_BUILD_TARGET_ENV_KEYS.NodeDistributionTarget,
                platform: "darwin",
                arch: DESKTOP_NODE_ARCHITECTURE.Arm64,
            }),
        /TAURI_ENV_TARGET_TRIPLE.*conflicts with CARGO_BUILD_TARGET/,
    );
});

test("universal macOS native builds require both Node architectures", () => {
    assert.deepEqual(
        getDesktopNativeNodeArchitectures(
            DESKTOP_NODE_DIST_TARGET.DarwinUniversal,
        ),
        MACOS_UNIVERSAL_NATIVE_ARCHITECTURES.map(
            ({ nodeArchitecture }) => nodeArchitecture,
        ),
    );
    assert.deepEqual(
        getDesktopNativeNodeArchitectures(DESKTOP_NODE_DIST_TARGET.WindowsX64),
        [DESKTOP_NODE_ARCHITECTURE.X64],
    );
});

test("Windows Sharp staging excludes a nonexistent separate libvips package", () => {
    assert.deepEqual(
        getSharpRuntimePackageNames(DESKTOP_NODE_DIST_TARGET.WindowsX64),
        ["@img/sharp-win32-x64"],
    );
});

test("better-sqlite3 selection carries only its runtime loader and binding", () => {
    assert.deepEqual(
        getDesktopRuntimePackageFileSelection(
            NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.BetterSqlite3,
        ).required,
        [
            "package.json",
            "LICENSE",
            "lib",
            BETTER_SQLITE3_NATIVE_BINDING_RELATIVE_PATH,
        ],
    );
});

test("package resolution follows the locked parent dependency graph", () => {
    assert.deepEqual(
        getDesktopRuntimePackageSourceIssuer(
            NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.BetterSqlite3,
            DESKTOP_RUNTIME_DEPENDENCY_ROOTS.Trading,
        ),
        { workspaceRelativePath: "trading/package.json" },
    );
    assert.deepEqual(
        getDesktopRuntimePackageSourceIssuer(
            NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.Sharp,
            DESKTOP_RUNTIME_DEPENDENCY_ROOTS.Indexer,
        ),
        { workspaceRelativePath: "indexer/package.json" },
    );
    assert.deepEqual(
        getDesktopRuntimePackageSourceIssuer(
            DESKTOP_RUNTIME_TRANSITIVE_PACKAGE_NAMES.FileUriToPath,
            DESKTOP_RUNTIME_DEPENDENCY_ROOTS.Trading,
        ),
        { packageName: DESKTOP_RUNTIME_TRANSITIVE_PACKAGE_NAMES.Bindings },
    );
    assert.deepEqual(
        getDesktopRuntimePackageSourceIssuer(
            "@img/sharp-linux-x64",
            DESKTOP_RUNTIME_DEPENDENCY_ROOTS.Backend,
        ),
        { packageName: NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.Sharp },
    );
    assert.throws(
        () =>
            getDesktopRuntimePackageSourceIssuer(
                NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.Sharp,
                DESKTOP_RUNTIME_DEPENDENCY_ROOTS.Trading,
            ),
        /does not own the Sharp/,
    );
    assert.throws(
        () =>
            getDesktopRuntimePackageSourceIssuer(
                "unreviewed-package",
                DESKTOP_RUNTIME_DEPENDENCY_ROOTS.Backend,
            ),
        /Unreviewed desktop runtime package/,
    );
});

test("host target inference is explicit and rejects unsupported targets", () => {
    assert.equal(
        inferDesktopNodeDistTarget("linux", DESKTOP_NODE_ARCHITECTURE.X64),
        DESKTOP_NODE_DIST_TARGET.LinuxX64,
    );
    assert.equal(
        inferDesktopNodeDistTarget("darwin", DESKTOP_NODE_ARCHITECTURE.Arm64),
        DESKTOP_NODE_DIST_TARGET.DarwinArm64,
    );
    assert.throws(
        () =>
            inferDesktopNodeDistTarget(
                "freebsd",
                DESKTOP_NODE_ARCHITECTURE.X64,
            ),
        /Unsupported platform\/arch/,
    );
    assert.throws(
        () => getSharpRuntimePackageNames("unsupported-target"),
        /Unsupported DESKTOP_NODE_DIST_TARGET/,
    );
});
