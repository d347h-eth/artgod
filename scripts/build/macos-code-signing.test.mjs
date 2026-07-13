import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DESKTOP_NODE_ARCHITECTURE } from "./native-runtime-dependencies.mjs";

import {
    assertRequiredBundleExecutables,
    createMacOSCodeSignArguments,
    resolveMacOSCodeSigningEntitlements,
    verifyNodeRuntimeEntitlements,
    verifyNodeRuntimeStartup,
} from "./macos-code-signing.mjs";

const signingIdentity = "Developer ID Application: Test Maintainer (TEAMID)";
const stagedNodePath = "/workspace/src-tauri/resources/runtime/node/node";
const bundledNodePath =
    "/Volumes/ArtGod/ArtGod.app/Contents/Resources/resources/runtime/node/node";
const bundledAppPath = "/Volumes/ArtGod/ArtGod.app";
const requiredBundleMachOFiles = [
    `${bundledAppPath}/Contents/MacOS/artgod-desktop`,
    bundledNodePath,
    `${bundledAppPath}/Contents/Resources/resources/runtime/nats/nats-server`,
    `${bundledAppPath}/Contents/MacOS/artgod-secret-prompt`,
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
        /Missing required signed executable.*Tauri app executable/,
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
