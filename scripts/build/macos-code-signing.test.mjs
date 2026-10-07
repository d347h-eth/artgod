import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    cp,
    mkdtemp,
    mkdir,
    readFile,
    readdir,
    rm,
    writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    DESKTOP_NODE_ARCHITECTURE,
    DESKTOP_NODE_DIST_TARGET,
    MACOS_UNIVERSAL_NATIVE_ARCHITECTURES,
    SHARP_RUNTIME_PACKAGES_BY_NODE_TARGET,
} from "./native-runtime-dependencies.mjs";

import {
    assertMacOSBundleMinimumSystemVersion,
    assertRequiredBundleExecutables,
    createMacOSCodeSignArguments,
    MACOS_MINIMUM_SYSTEM_VERSION_BY_ARCHITECTURE_PLIST_KEY,
    MACOS_MINIMUM_SYSTEM_VERSION_PLIST_KEY,
    resolveMacOSUniversalWalletRecipientIntegritySnapshotPaths,
    resolveMacOSCodeSigningEntitlements,
    verifyBundledNatsLoopbackStartup,
    verifyMacOSWalletRecipientIntegritySnapshots,
    verifyMacOSAppBundleAtPath,
    verifyMacOSDmgBundle,
    verifyNodeRuntimeEntitlements,
    verifyNodeRuntimeStartup,
    verifySecretPromptStartup,
} from "./macos-code-signing.mjs";
import {
    WALLET_RECIPIENT_INTEGRITY_SNAPSHOT_FILE_NAME,
    WALLET_RECIPIENT_INTEGRITY_SNAPSHOT_VERSION,
} from "./wallet-recipient-integrity-snapshot.mjs";

const signingIdentity = "Developer ID Application: Test Maintainer (TEAMID)";
const stagedNodePath = "/workspace/src-tauri/resources/runtime/node/node";
const bundledNodePath =
    "/Volumes/ArtGod/ArtGod.app/Contents/Resources/resources/runtime/node/node";
const bundledNatsPath =
    "/Volumes/ArtGod/ArtGod.app/Contents/Resources/resources/runtime/nats/nats-server";
const bundledSecretPromptPath =
    "/Volumes/ArtGod/ArtGod.app/Contents/MacOS/artgod-secret-prompt";
const bundledAppPath = "/Volumes/ArtGod/ArtGod.app";
const requiredBundleMachOFiles = [
    `${bundledAppPath}/Contents/MacOS/artgod-desktop`,
    bundledNodePath,
    bundledNatsPath,
    bundledSecretPromptPath,
];
const expectedEntitlements = {
    "com.apple.security.cs.allow-jit": true,
};

test("signs staged runtimes before Rust embeds their integrity hashes", async () => {
    const tauriConfig = JSON.parse(
        await readFile(
            new URL("../../src-tauri/tauri.conf.json", import.meta.url),
            "utf8",
        ),
    );
    const buildCommand = tauriConfig.build.beforeBuildCommand;
    const sqliteBindingIndex = buildCommand.indexOf(
        "build:sqlite-native --if-needed",
    );
    const runtimeResourcesIndex = buildCommand.indexOf(
        "build:desktop-runtime-resources",
    );
    const sidecarsIndex = buildCommand.indexOf("build:desktop-sidecars");
    const signingIndex = buildCommand.indexOf(
        "macos-code-signing.mjs sign-staged",
    );

    assert.ok(sqliteBindingIndex >= 0);
    assert.ok(runtimeResourcesIndex >= 0);
    assert.ok(sqliteBindingIndex < runtimeResourcesIndex);
    assert.ok(sidecarsIndex > runtimeResourcesIndex);
    assert.ok(signingIndex > sidecarsIndex);
    assert.equal(tauriConfig.build.beforeBundleCommand, undefined);
});

test("keeps the Tauri minimum macOS version aligned with release docs", async () => {
    const [tauriConfig, readme] = await Promise.all([
        readFile(
            new URL("../../src-tauri/tauri.conf.json", import.meta.url),
            "utf8",
        ).then(JSON.parse),
        readFile(new URL("../../README.md", import.meta.url), "utf8"),
    ]);
    const minimumSystemVersion =
        tauriConfig.bundle?.macOS?.minimumSystemVersion;

    assert.equal(typeof minimumSystemVersion, "string");
    assert.match(minimumSystemVersion, /^\d+\.\d+$/);
    assert.equal(
        readme.includes(`macOS ${minimumSystemVersion}+`),
        true,
        "README macOS support must match the Tauri bundle minimum.",
    );
    assert.doesNotThrow(() =>
        assertMacOSBundleMinimumSystemVersion(
            {
                [MACOS_MINIMUM_SYSTEM_VERSION_PLIST_KEY]: minimumSystemVersion,
            },
            minimumSystemVersion,
        ),
    );
    assert.throws(
        () => assertMacOSBundleMinimumSystemVersion({}, minimumSystemVersion),
        /does not match Tauri config.*found missing/,
    );
    assert.throws(
        () =>
            assertMacOSBundleMinimumSystemVersion(
                {
                    [MACOS_MINIMUM_SYSTEM_VERSION_PLIST_KEY]:
                        minimumSystemVersion,
                    [MACOS_MINIMUM_SYSTEM_VERSION_BY_ARCHITECTURE_PLIST_KEY]:
                        {},
                },
                minimumSystemVersion,
            ),
        /must be absent.*cannot override/,
    );
});

test("requires the Tauri executable with every bundled process entry point", () => {
    assert.doesNotThrow(() =>
        assertRequiredBundleExecutables(
            bundledAppPath,
            requiredBundleMachOFiles,
        ),
    );
    assert.throws(
        () =>
            assertRequiredBundleExecutables(
                bundledAppPath,
                requiredBundleMachOFiles.slice(1),
            ),
        /Missing required executable.*Tauri app executable/,
    );
});

test("applies the dedicated JIT entitlement only to bundled Node", async () => {
    const entitlementsPath =
        resolveMacOSCodeSigningEntitlements(stagedNodePath);
    assert.ok(entitlementsPath);
    assert.equal(
        path
            .normalize(entitlementsPath)
            .endsWith(
                path.join("src-tauri", "entitlements", "node-runtime.plist"),
            ),
        true,
    );
    assert.equal(
        resolveMacOSCodeSigningEntitlements(bundledNodePath),
        entitlementsPath,
    );

    for (const unrelatedMachOPath of [
        "/workspace/src-tauri/resources/runtime/nats/nats-server",
        "/workspace/src-tauri/resources/runtime/trading/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
        "/workspace/src-tauri/binaries/artgod-secret-prompt-aarch64-apple-darwin",
        "/Volumes/ArtGod/ArtGod.app/Contents/MacOS/artgod-desktop",
    ]) {
        assert.equal(
            resolveMacOSCodeSigningEntitlements(unrelatedMachOPath),
            undefined,
        );
    }

    assert.equal(
        await readFile(entitlementsPath, "utf8"),
        [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
            '<plist version="1.0">',
            "<dict>",
            "    <key>com.apple.security.cs.allow-jit</key>",
            "    <true/>",
            "</dict>",
            "</plist>",
            "",
        ].join("\n"),
    );
});

test("adds Node entitlements to the hardened-runtime signing command", () => {
    const entitlementsPath =
        resolveMacOSCodeSigningEntitlements(stagedNodePath);
    assert.deepEqual(
        createMacOSCodeSignArguments(signingIdentity, stagedNodePath),
        [
            "--force",
            "--options",
            "runtime",
            "--timestamp",
            "--entitlements",
            entitlementsPath,
            "--sign",
            signingIdentity,
            stagedNodePath,
        ],
    );
    assert.deepEqual(
        createMacOSCodeSignArguments(
            signingIdentity,
            "/workspace/src-tauri/resources/runtime/nats/nats-server",
        ),
        [
            "--force",
            "--options",
            "runtime",
            "--timestamp",
            "--sign",
            signingIdentity,
            "/workspace/src-tauri/resources/runtime/nats/nats-server",
        ],
    );
});

test("requires signed Node entitlements to match the dedicated plist", async () => {
    const temporaryDirectory = await mkdtemp(
        path.join(os.tmpdir(), "artgod-node-entitlements-test-"),
    );
    const calls = [];

    try {
        await verifyNodeRuntimeEntitlements(stagedNodePath, {
            temporaryDirectory,
            async commandRunner(command, args, options) {
                calls.push({ command, args, options });
                if (command === "codesign") {
                    return {
                        stdout: await readFile(
                            resolveMacOSCodeSigningEntitlements(stagedNodePath),
                            "utf8",
                        ),
                        stderr: "",
                    };
                }
                assert.equal(command, "plutil");
                return {
                    stdout: JSON.stringify(expectedEntitlements),
                    stderr: "",
                };
            },
        });

        assert.equal(calls[0].command, "codesign");
        assert.deepEqual(calls[0].args, [
            "--display",
            "--entitlements",
            ":-",
            stagedNodePath,
        ]);
        assert.equal(
            calls.filter(({ command }) => command === "plutil").length,
            2,
        );
        assert.deepEqual(await readdir(temporaryDirectory), []);
    } finally {
        await rm(temporaryDirectory, { force: true, recursive: true });
    }
});

test("rejects broader embedded Node entitlements and removes temporary data", async () => {
    const temporaryDirectory = await mkdtemp(
        path.join(os.tmpdir(), "artgod-node-entitlements-test-"),
    );
    let propertyListReadCount = 0;

    try {
        await assert.rejects(
            verifyNodeRuntimeEntitlements(stagedNodePath, {
                temporaryDirectory,
                async commandRunner(command) {
                    if (command === "codesign") {
                        return { stdout: "<plist></plist>", stderr: "" };
                    }
                    propertyListReadCount += 1;
                    return {
                        stdout: JSON.stringify(
                            propertyListReadCount === 1
                                ? expectedEntitlements
                                : {
                                      ...expectedEntitlements,
                                      "com.apple.security.cs.allow-unsigned-executable-memory": true,
                                  },
                        ),
                        stderr: "",
                    };
                },
            }),
            /entitlements do not match/,
        );
        assert.deepEqual(await readdir(temporaryDirectory), []);
    } finally {
        await rm(temporaryDirectory, { force: true, recursive: true });
    }
});

test("starts bundled Node with a V8-isolate smoke expression", async () => {
    const calls = [];
    const messages = [];

    await verifyNodeRuntimeStartup(bundledNodePath, {
        expectedArchitecture: DESKTOP_NODE_ARCHITECTURE.Arm64,
        async commandRunner(command, args, options) {
            calls.push({ command, args, options });
            return { stdout: "arm64 v24.3.0\n", stderr: "" };
        },
        logger(message) {
            messages.push(message);
        },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, bundledNodePath);
    assert.equal(calls[0].args[0], "--eval");
    assert.match(calls[0].args[1], /process\.arch/);
    assert.deepEqual(calls[0].options, { capture: true });
    assert.deepEqual(messages, ["Started bundled Node runtime: arm64 v24.3.0"]);
});

test("rejects a bundled Node slice that does not match the runner", async () => {
    await assert.rejects(
        verifyNodeRuntimeStartup(bundledNodePath, {
            expectedArchitecture: DESKTOP_NODE_ARCHITECTURE.X64,
            async commandRunner() {
                return { stdout: "arm64 v24.3.0\n", stderr: "" };
            },
            logger() {
                assert.fail(
                    "A mismatched Node slice must not be logged as success.",
                );
            },
        }),
        /reported architecture arm64; expected x64/,
    );
});

test("rejects a bundled Node smoke command with no runtime identity", async () => {
    await assert.rejects(
        verifyNodeRuntimeStartup(bundledNodePath, {
            async commandRunner() {
                return { stdout: "", stderr: "" };
            },
            logger() {
                assert.fail("Empty Node output must not be logged as success.");
            },
        }),
        /reported no runtime identity/,
    );
});

test("resolves both concrete Rust snapshots for a universal macOS build", () => {
    const cargoTargetRoot = path.join("workspace", "src-tauri", "target");

    assert.deepEqual(
        resolveMacOSUniversalWalletRecipientIntegritySnapshotPaths(
            cargoTargetRoot,
        ),
        MACOS_UNIVERSAL_NATIVE_ARCHITECTURES.map(({ rustTarget }) => ({
            rustTarget,
            snapshotPath: path.join(
                cargoTargetRoot,
                rustTarget,
                "release",
                WALLET_RECIPIENT_INTEGRITY_SNAPSHOT_FILE_NAME,
            ),
        })),
    );
});

test("requires the mounted runtime to match both native-slice snapshots", async () => {
    const temporaryDirectory = await mkdtemp(
        path.join(os.tmpdir(), "artgod-macos-snapshot-test-"),
    );
    const runtimeRoot = path.join(temporaryDirectory, "runtime");

    try {
        const snapshot = await writeWalletRecipientRuntimeFixture(runtimeRoot);
        const snapshots = MACOS_UNIVERSAL_NATIVE_ARCHITECTURES.map(
            ({ rustTarget }) => ({ rustTarget, snapshot }),
        );

        await verifyMacOSWalletRecipientIntegritySnapshots(
            snapshots,
            runtimeRoot,
        );

        const x64Target = MACOS_UNIVERSAL_NATIVE_ARCHITECTURES.find(
            ({ nodeArchitecture }) =>
                nodeArchitecture === DESKTOP_NODE_ARCHITECTURE.X64,
        ).rustTarget;
        const arm64Target = MACOS_UNIVERSAL_NATIVE_ARCHITECTURES.find(
            ({ nodeArchitecture }) =>
                nodeArchitecture === DESKTOP_NODE_ARCHITECTURE.Arm64,
        ).rustTarget;
        const divergentSnapshotPattern = new RegExp(
            `Universal macOS wallet-recipient integrity snapshots differ between ${arm64Target} and ${x64Target}`,
        );
        const mismatchedHashSnapshots = snapshots.map((entry) =>
            entry.rustTarget === x64Target
                ? {
                      ...entry,
                      snapshot: {
                          ...snapshot,
                          files: snapshot.files.map((file, index) =>
                              index === 0
                                  ? { ...file, sha256: "0".repeat(64) }
                                  : file,
                          ),
                      },
                  }
                : entry,
        );

        await assert.rejects(
            verifyMacOSWalletRecipientIntegritySnapshots(
                mismatchedHashSnapshots,
                runtimeRoot,
            ),
            divergentSnapshotPattern,
        );

        const mismatchedClosureSnapshots = snapshots.map((entry) =>
            entry.rustTarget === x64Target
                ? {
                      ...entry,
                      snapshot: {
                          protectedRoots: ["node"],
                          files: snapshot.files.filter(({ relativePath }) =>
                              relativePath.startsWith("node/"),
                          ),
                      },
                  }
                : entry,
        );
        await assert.rejects(
            verifyMacOSWalletRecipientIntegritySnapshots(
                mismatchedClosureSnapshots,
                runtimeRoot,
            ),
            divergentSnapshotPattern,
        );

        await writeFile(
            path.join(runtimeRoot, "node", "node"),
            "packaged-mutation",
            "utf8",
        );
        await assert.rejects(
            verifyMacOSWalletRecipientIntegritySnapshots(
                snapshots,
                runtimeRoot,
            ),
            new RegExp(
                `Mounted macOS runtime does not match the ${arm64Target} wallet-recipient integrity snapshot`,
            ),
        );
    } finally {
        await rm(temporaryDirectory, { force: true, recursive: true });
    }
});

test("unsigned app verification retains architecture, integrity and runtime proofs", async (t) => {
    const fixture = await createBundleVerificationFixture(t);
    await verifyMacOSAppBundleAtPath(fixture.appPath, {
        ...fixture.options,
        requireCodeSignatures: false,
        walletRecipientIntegritySnapshots: fixture.snapshots,
    });
    assert.deepEqual(fixture.probes, [
        "node",
        "nats",
        "prompt",
        "dependencies",
    ]);
    assert.equal(fixture.commands.includes("codesign"), false);
    assert.ok(fixture.commands.includes("lipo"));
    assert.ok(fixture.commands.includes("otool"));
});

test("unsigned app verification refuses absent snapshots and altered packaged bytes", async (t) => {
    const fixture = await createBundleVerificationFixture(t);
    const options = { ...fixture.options, requireCodeSignatures: false };
    await assert.rejects(
        verifyMacOSAppBundleAtPath(fixture.appPath, options),
        /requires both Rust integrity snapshots/,
    );
    await assert.rejects(
        verifyMacOSAppBundleAtPath(fixture.appPath, {
            ...options,
            walletRecipientIntegritySnapshots: fixture.snapshots.slice(0, 1),
        }),
        /Missing wallet-recipient integrity snapshot/,
    );
    await writeFile(
        path.join(fixture.runtimeRoot, "node", "node"),
        "packaged mutation",
    );
    await assert.rejects(
        verifyMacOSAppBundleAtPath(fixture.appPath, {
            ...options,
            walletRecipientIntegritySnapshots: fixture.snapshots,
        }),
        /does not match.*wallet-recipient integrity snapshot/,
    );
    assert.deepEqual(fixture.probes, []);
});

test("unsigned app verification rejects a missing universal executable slice", async (t) => {
    const fixture = await createBundleVerificationFixture(t);
    await assert.rejects(
        verifyMacOSAppBundleAtPath(fixture.appPath, {
            ...fixture.options,
            requireCodeSignatures: false,
            walletRecipientIntegritySnapshots: fixture.snapshots,
            commandRunner(command, args, options) {
                if (
                    command === "lipo" &&
                    args.at(-1).endsWith("artgod-desktop")
                ) {
                    return Promise.resolve({ stdout: "arm64" });
                }
                return fixture.options.commandRunner(command, args, options);
            },
        }),
        /architecture coverage is incomplete/,
    );
    assert.deepEqual(fixture.probes, []);
});

test("release app verification defaults to signatures before executable probes", async (t) => {
    const fixture = await createBundleVerificationFixture(t);
    await assert.rejects(
        verifyMacOSAppBundleAtPath(fixture.appPath, {
            ...fixture.options,
            walletRecipientIntegritySnapshots: fixture.snapshots,
        }),
        /Signature rejected/,
    );
    assert.ok(fixture.commands.includes("codesign"));
    assert.deepEqual(fixture.probes, []);
});

test("unsigned DMG verification requires both saved Rust snapshots and detaches after failure", async (t) => {
    const fixture = await createBundleVerificationFixture(t);
    const mountCommands = [];
    const cargoTargetRoot = path.join(fixture.rootDir, "cargo-target");
    for (const {
        snapshotPath,
    } of resolveMacOSUniversalWalletRecipientIntegritySnapshotPaths(
        cargoTargetRoot,
    )) {
        await mkdir(path.dirname(snapshotPath), { recursive: true });
        await writeFile(
            snapshotPath,
            JSON.stringify({
                version: WALLET_RECIPIENT_INTEGRITY_SNAPSHOT_VERSION,
                ...fixture.snapshots[0].snapshot,
            }),
        );
    }
    const options = {
        ...fixture.options,
        inputPath: path.join(fixture.rootDir, "ArtGod.dmg"),
        requireCodeSignatures: false,
        temporaryDirectory: fixture.temporaryDirectory,
        async commandRunner(command, args, commandOptions) {
            if (command === "hdiutil") {
                mountCommands.push(args[0]);
                if (args[0] === "attach") {
                    await cp(
                        fixture.appPath,
                        path.join(args.at(-1), path.basename(fixture.appPath)),
                        { recursive: true },
                    );
                }
                return { stdout: "" };
            }
            return fixture.options.commandRunner(command, args, commandOptions);
        },
    };
    await assert.rejects(
        verifyMacOSDmgBundle(options),
        /requires the Cargo target root/,
    );
    assert.deepEqual(mountCommands, []);
    await verifyMacOSDmgBundle({ ...options, cargoTargetRoot });
    assert.deepEqual(mountCommands, ["attach", "detach"]);
    assert.deepEqual(fixture.probes, [
        "node",
        "nats",
        "prompt",
        "dependencies",
    ]);
    assert.deepEqual(await readdir(fixture.temporaryDirectory), []);
    fixture.probes.length = 0;
    await writeFile(
        path.join(fixture.runtimeRoot, "node", "node"),
        "packaged mutation",
    );
    await assert.rejects(
        verifyMacOSDmgBundle({ ...options, cargoTargetRoot }),
        /does not match.*wallet-recipient integrity snapshot/,
    );
    assert.deepEqual(mountCommands, ["attach", "detach", "attach", "detach"]);
    assert.deepEqual(fixture.probes, []);
    assert.deepEqual(await readdir(fixture.temporaryDirectory), []);
    const [missingSnapshot] =
        resolveMacOSUniversalWalletRecipientIntegritySnapshotPaths(
            cargoTargetRoot,
        );
    await rm(missingSnapshot.snapshotPath);
    await assert.rejects(
        verifyMacOSDmgBundle({ ...options, cargoTargetRoot }),
        /Unable to read wallet-recipient integrity snapshot/,
    );
    assert.equal(mountCommands.length, 4);
});

async function createBundleVerificationFixture(t) {
    const tauriConfig = JSON.parse(
        await readFile(
            new URL("../../src-tauri/tauri.conf.json", import.meta.url),
            "utf8",
        ),
    );
    const rootDir = await mkdtemp(
        path.join(os.tmpdir(), "artgod-macos-bundle-test-"),
    );
    t.after(() => rm(rootDir, { recursive: true, force: true }));
    const appPath = path.join(rootDir, "ArtGod.app");
    const runtimeRoot = path.join(
        appPath,
        "Contents",
        "Resources",
        "resources",
        "runtime",
    );
    const snapshot = await writeWalletRecipientRuntimeFixture(runtimeRoot);
    const machOPaths = [
        "Contents/MacOS/artgod-desktop",
        "Contents/MacOS/artgod-secret-prompt",
        "Contents/Resources/resources/runtime/node/node",
        "Contents/Resources/resources/runtime/nats/nats-server",
        ...[
            DESKTOP_NODE_DIST_TARGET.DarwinArm64,
            DESKTOP_NODE_DIST_TARGET.DarwinX64,
        ].flatMap((nodeTarget) =>
            SHARP_RUNTIME_PACKAGES_BY_NODE_TARGET[nodeTarget].map(
                (packageName) =>
                    `Contents/Resources/resources/runtime/backend/node_modules/${packageName}/fixture.node`,
            ),
        ),
    ];
    for (const relativePath of machOPaths.filter(
        (entry) => !entry.endsWith("node/node"),
    )) {
        const filePath = path.join(appPath, relativePath);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, "Mach-O fixture");
    }
    const temporaryDirectory = path.join(rootDir, "mounts");
    await mkdir(temporaryDirectory);
    const commands = [];
    const probes = [];
    const options = {
        logger() {},
        async commandRunner(command, args) {
            commands.push(command);
            if (command === "file")
                return {
                    stdout: machOPaths.some((entry) => args[1].endsWith(entry))
                        ? "Mach-O executable"
                        : "ASCII text",
                };
            if (command === "lipo")
                return {
                    stdout: args.at(-1).includes("darwin-arm64/")
                        ? "arm64"
                        : args.at(-1).includes("darwin-x64/")
                          ? "x86_64"
                          : "arm64 x86_64",
                };
            if (command === "otool")
                return {
                    stdout: "cmd LC_BUILD_VERSION\nplatform 1\nminos 11.0\n",
                };
            if (command === "plutil")
                return {
                    stdout: JSON.stringify({
                        [MACOS_MINIMUM_SYSTEM_VERSION_PLIST_KEY]:
                            tauriConfig.bundle.macOS.minimumSystemVersion,
                    }),
                };
            if (command === "codesign") throw new Error("Signature rejected");
            assert.ok(command.endsWith("/node/node"));
            probes.push("node");
            return { stdout: `${process.arch} v24.3.0` };
        },
        async natsVerifier({ natsBinaryPath }) {
            assert.ok(natsBinaryPath.endsWith("/nats/nats-server"));
            probes.push("nats");
        },
        async promptProcessRunner(command) {
            assert.ok(command.endsWith("/Contents/MacOS/artgod-secret-prompt"));
            probes.push("prompt");
            return {
                exitCode: 1,
                signal: null,
                stdoutProduced: false,
                stderrProduced: false,
            };
        },
        async dependencyVerifier({ resourcesRootDir, nodeBinaryPath }) {
            assert.equal(
                nodeBinaryPath,
                path.join(resourcesRootDir, "node", "node"),
            );
            probes.push("dependencies");
        },
    };
    return {
        rootDir,
        appPath,
        runtimeRoot,
        temporaryDirectory,
        commands,
        probes,
        options,
        snapshots: MACOS_UNIVERSAL_NATIVE_ARCHITECTURES.map(
            ({ rustTarget }) => ({ rustTarget, snapshot }),
        ),
    };
}

test("reuses the loopback listener proof for NATS inside the mounted app", async () => {
    const calls = [];
    const messages = [];

    await verifyBundledNatsLoopbackStartup(bundledNatsPath, {
        async natsVerifier(input) {
            calls.push(input);
        },
        logger(message) {
            messages.push(message);
        },
    });

    assert.deepEqual(calls, [{ natsBinaryPath: bundledNatsPath }]);
    assert.deepEqual(messages, [
        `Started bundled NATS on numeric IPv4 loopback: ${bundledNatsPath}`,
    ]);
});

test("starts the secret prompt through silent owner loss before native UI", async () => {
    const calls = [];
    const messages = [];

    await verifySecretPromptStartup(bundledSecretPromptPath, {
        async processRunner(command, args, options) {
            calls.push({ command, args, options });
            return {
                exitCode: 1,
                signal: null,
                stdoutProduced: false,
                stderrProduced: false,
            };
        },
        logger(message) {
            messages.push(message);
        },
    });

    assert.deepEqual(calls, [
        {
            command: bundledSecretPromptPath,
            args: ["--action", "unlock"],
            options: { timeoutMilliseconds: 5_000 },
        },
    ]);
    assert.deepEqual(messages, [
        `Started bundled secret prompt without opening native UI: ${bundledSecretPromptPath}`,
    ]);
});

test("rejects an abnormal secret-prompt startup result", async () => {
    await assert.rejects(
        verifySecretPromptStartup(bundledSecretPromptPath, {
            async processRunner() {
                return {
                    exitCode: 1,
                    signal: null,
                    stdoutProduced: false,
                    stderrProduced: true,
                };
            },
            logger() {
                assert.fail(
                    "An abnormal prompt must not be logged as success.",
                );
            },
        }),
        /produced unexpected process output/,
    );
});

async function writeWalletRecipientRuntimeFixture(runtimeRoot) {
    const contentsByPath = new Map([
        ["node/node", "node-runtime"],
        ["trading/runtime.mjs", "trading-runtime"],
    ]);
    for (const [relativePath, contents] of contentsByPath) {
        const filePath = path.join(runtimeRoot, relativePath);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, contents, "utf8");
    }

    return {
        protectedRoots: ["node", "trading"],
        files: [...contentsByPath].map(([relativePath, contents]) => ({
            relativePath,
            sha256: createHash("sha256").update(contents).digest("hex"),
        })),
    };
}
