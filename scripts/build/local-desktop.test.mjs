import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
    localDesktopBuildInvocation,
    localTauriConfig,
} from "./local-desktop-command.mjs";
import {
    LOCAL_DESKTOP_FEATURE,
    LOCAL_PROFILE,
    LOCAL_PROFILE_MARKER,
    LOCAL_RUNTIME_RELATIVE_PATH,
    localDesktopPaths,
    projectRoot,
    validateLocalRuntimeMetafile,
} from "./local-desktop-contract.mjs";
import {
    profilerNativeFiles,
    assertLocalRuntimeProfiles,
    stageLocalDesktopDependencies,
} from "./local-desktop-dependencies.mjs";
import { assertDesktopRuntimeBuildProfileMarkers } from "./desktop-runtime-dependency-staging.mjs";
import {
    RUNTIME_BUILD_PROFILE,
    runtimeBuildProfileMarkerSource,
} from "./runtime-build-profile.mjs";

test("local CLI pairs native capability, hook, resources and separate output", async () => {
    const production = JSON.parse(
        await readFile(
            new URL("../../src-tauri/tauri.conf.json", import.meta.url),
        ),
    );
    const invocation = localDesktopBuildInvocation([], {
        CARGO_TARGET_DIR: "production-output",
        TAURI_CONFIG: "unrelated",
    });
    assert.ok(invocation.args.includes("--no-bundle"));
    assert.equal(
        invocation.args[invocation.args.indexOf("--features") + 1],
        LOCAL_DESKTOP_FEATURE,
    );
    const overlay = JSON.parse(
        invocation.args[invocation.args.indexOf("--config") + 1],
    );
    assert.deepEqual(overlay, localTauriConfig());
    assert.deepEqual(overlay.bundle.resources, [LOCAL_RUNTIME_RELATIVE_PATH]);
    assert.notEqual(
        overlay.build.beforeBuildCommand,
        production.build.beforeBuildCommand,
    );
    assert.notEqual(
        overlay.bundle.externalBin[0],
        production.bundle.externalBin[0],
    );
    assert.equal(overlay.identifier, undefined); // Retain the app's real identity and data.
    assert.equal(invocation.env.CARGO_TARGET_DIR, localDesktopPaths().cargo);
    assert.equal(invocation.env.TAURI_CONFIG, undefined);
    const bundle = localDesktopBuildInvocation([
        "--bundle",
        "--bundles",
        "deb",
        "--target",
        "x86_64-unknown-linux-gnu",
    ]);
    assert.ok(!bundle.args.includes("--no-bundle"));
    assert.deepEqual(bundle.args.slice(-4), [
        "--bundles",
        "deb",
        "--target",
        "x86_64-unknown-linux-gnu",
    ]);
    for (const args of [
        ["--config", "other.json"],
        ["--features", "other"],
        ["--", "--target-dir", "production"],
        ["--bundles", "deb"],
    ]) {
        assert.throws(() => localDesktopBuildInvocation(args));
    }
});

test("stagers reject the other target before copying any dependency", async () => {
    const temporaryRoot = path.join(projectRoot, "tmp");
    await mkdir(temporaryRoot, { recursive: true });
    const root = await mkdtemp(path.join(temporaryRoot, "local-profile-test-"));
    for (const runtime of ["backend", "indexer", "trading"]) {
        const output = path.join(root, runtime, "dist-desktop");
        await mkdir(output, { recursive: true });
        await writeFile(
            path.join(output, LOCAL_PROFILE_MARKER),
            JSON.stringify(LOCAL_PROFILE),
        );
    }
    await assertLocalRuntimeProfiles(root);
    await assert.rejects(
        assertDesktopRuntimeBuildProfileMarkers(root),
        /expected full or desktop/,
    );
    await writeFile(
        path.join(root, "indexer", "dist-desktop", LOCAL_PROFILE_MARKER),
        runtimeBuildProfileMarkerSource(RUNTIME_BUILD_PROFILE.DESKTOP),
    );
    await assert.rejects(
        stageLocalDesktopDependencies({
            rootDir: root,
            destinationRootDir: root,
            nodeTarget: "linux-x64",
            nodeAbi: "137",
            pnpApi: {},
        }),
        /expected desktop-local-observability/,
    );
});

test("profiler staging selects only the target and exact Node ABI", () => {
    assert.deepEqual(profilerNativeFiles("linux-x64", "137"), [
        "prebuilds/linux-x64/dd_pprof.node.abi137.node",
    ]);
    assert.deepEqual(profilerNativeFiles("darwin-universal", "137"), [
        "prebuilds/darwin-x64/dd_pprof.node.abi137.node",
        "prebuilds/darwin-arm64/dd_pprof.node.abi137.node",
    ]);
    assert.throws(
        () => profilerNativeFiles("win-arm64", "137"),
        /no local desktop prebuild/,
    );
    assert.throws(() => profilerNativeFiles("linux-x64", undefined), /ABI/);
});

test("local graph validation rejects missing instrumentation and desktop no-ops", () => {
    const inputs = Object.fromEntries(
        ["apm.ts", "metrics/prometheus.ts", "metrics/server.ts"].map((name) => [
            `shared/observability/${name}`,
            {},
        ]),
    );
    validateLocalRuntimeMetafile("backend", { inputs });
    assert.throws(
        () => validateLocalRuntimeMetafile("backend", { inputs: {} }),
        /missing/,
    );
    assert.throws(
        () =>
            validateLocalRuntimeMetafile("indexer", {
                inputs: {
                    ...inputs,
                    "shared/observability/apm.desktop.ts": {},
                },
            }),
        /no-op/,
    );
});

test("separate local builder retains all current production runtime entrypoints", async () => {
    const sources = await Promise.all(
        ["build-runtime-artifacts.mjs", "build-local-desktop-runtime.mjs"].map(
            (name) => readFile(new URL(name, import.meta.url), "utf8"),
        ),
    );
    const entryFiles = (source) =>
        [...source.matchAll(/"([a-z-]+\.ts)"/g)]
            .map((match) => match[1])
            .sort();
    assert.deepEqual(entryFiles(sources[1]), entryFiles(sources[0]));
});
