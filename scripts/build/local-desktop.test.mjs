import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
    localDesktopBuildInvocation,
    localTauriConfig,
    buildLocalDesktop,
    localDesktopDevInvocation,
    devLocalDesktop,
} from "./local-desktop-command.mjs";
import {
    LOCAL_DESKTOP_FEATURE,
    LOCAL_PROFILE,
    LOCAL_PROFILE_MARKER,
    LOCAL_RUNTIME_RELATIVE_PATH,
    LOCAL_LINUX_RUNTIME_PATHS,
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
import {
    buildLockedTauri,
    runLockedTauri,
    TAURI_OPERATION,
} from "./build-tauri.mjs";
import { prepareLocalDesktop } from "./prepare-local-desktop.mjs";

test("local dev prepares the full closure before the locked debug desktop starts", async () => {
    const commands = [];
    for (const platform of ["linux", "win32"]) {
        await devLocalDesktop([], {
            platform,
            environment: { TAURI_CONFIG: "production", APPLE_ID: "unused" },
            async prepare(options) {
                assert.equal(options.development, true);
                await prepareLocalDesktop({
                    ...options,
                    async runCommand(command, args, { env }) {
                        commands.push(args);
                        assert.equal(
                            env.CARGO_TARGET_DIR,
                            localDesktopPaths().cargo,
                        );
                        assert.equal(env.TAURI_CONFIG, undefined);
                        assert.equal(env.APPLE_ID, undefined);
                    },
                });
            },
            async runTauri(operation, args, options) {
                assert.equal(operation, TAURI_OPERATION.Dev);
                assert.equal(commands.length, 5);
                assert.deepEqual(
                    commands.map((args) => args.slice(-1)[0]),
                    [
                        "--if-needed",
                        "build:userland",
                        "scripts/build/build-local-desktop-runtime.mjs",
                        "scripts/build/prepare-local-desktop-resources.mjs",
                        "debug",
                    ],
                );
                assert.ok(
                    commands.every((args) => !args.includes("build:admin")),
                );
                const overlay = JSON.parse(args[args.indexOf("--config") + 1]);
                assert.equal(
                    overlay.build.beforeDevCommand,
                    "node ./scripts/build/dev-frontend-target.mjs admin",
                );
                assert.ok(
                    overlay.bundle.externalBin[0].startsWith("binaries-local/"),
                );
                await runLockedTauri(operation, args, {
                    ...options,
                    platform,
                    resolveCliEntrypoint: () => "installed-tauri.js",
                    async runCommand(command, commandArgs) {
                        assert.ok(commandArgs.includes("dev"));
                        assert.ok(commandArgs.includes(LOCAL_DESKTOP_FEATURE));
                        assert.ok(!commandArgs.includes("--release"));
                        assert.deepEqual(commandArgs.slice(-2), [
                            "--",
                            "--locked",
                        ]);
                    },
                });
                commands.length = 0;
            },
        });
    }
    for (const args of [
        ["--release"],
        ["--config", "other.json"],
        ["--features", "other"],
    ])
        assert.throws(() => localDesktopDevInvocation(args));
});

test("local dev help does not prepare artifacts or start the app", async () => {
    await devLocalDesktop(["--help"], {
        prepare() {
            assert.fail("Help must not prepare local artifacts");
        },
        async runTauri(operation, args) {
            assert.equal(operation, TAURI_OPERATION.Dev);
            assert.ok(args.includes("--help"));
        },
    });
});

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
    assert.deepEqual(
        overlay.bundle.resources,
        process.platform === "linux" ? [] : [LOCAL_RUNTIME_RELATIVE_PATH],
    );
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

test("local builds keep Cargo locked and isolate Windows launcher selection", async () => {
    for (const platform of ["linux", "win32"]) {
        await buildLocalDesktop([], {
            platform,
            environment: {},
            buildTauri: (args, options) =>
                buildLockedTauri(args, {
                    ...options,
                    platform,
                    resolveCliEntrypoint: () => "installed-tauri.js",
                    async runCommand(command, commandArgs, { env }) {
                        assert.equal(
                            command,
                            platform === "win32" ? process.execPath : "yarn",
                        );
                        assert.deepEqual(commandArgs.slice(-2), [
                            "--",
                            "--locked",
                        ]);
                        assert.ok(commandArgs.includes(LOCAL_DESKTOP_FEATURE));
                        assert.equal(
                            env.CARGO_TARGET_DIR,
                            localDesktopPaths().cargo,
                        );
                    },
                }),
        });
    }
});

test("Linux packaging replaces inherited production mappings with local destinations", async () => {
    const production = JSON.parse(
        await readFile(
            new URL("../../src-tauri/tauri.linux.conf.json", import.meta.url),
        ),
    );
    const overlay = localTauriConfig("linux");
    assert.deepEqual(overlay.bundle.resources, []);
    for (const [format, destination] of Object.entries(
        LOCAL_LINUX_RUNTIME_PATHS,
    )) {
        const files = overlay.bundle.linux[format].files;
        assert.equal(files[destination], LOCAL_RUNTIME_RELATIVE_PATH);
        for (const inherited of Object.keys(
            production.bundle.linux[format].files,
        )) {
            assert.equal(files[inherited], null);
        }
    }
    assert.deepEqual(localTauriConfig("darwin").bundle.resources, [
        LOCAL_RUNTIME_RELATIVE_PATH,
    ]);
});

test("local AppImage packaging admits pinned tools in the isolated Cargo output", async () => {
    const calls = [];
    await buildLocalDesktop(["--bundle", "--bundles", "appimage,deb"], {
        platform: "linux",
        environment: {},
        async prepareLinuxTools({ cacheDirectory }) {
            calls.push("prepare");
            assert.ok(path.isAbsolute(cacheDirectory));
        },
        async resolveLinuxTools({ environment }) {
            calls.push("resolve");
            assert.equal(
                environment.CARGO_TARGET_DIR,
                localDesktopPaths().cargo,
            );
            return path.join(localDesktopPaths().cargo, ".tauri");
        },
        async stageLinuxTools({ cacheDirectory, localToolsDirectory }) {
            calls.push("stage");
            assert.ok(path.isAbsolute(cacheDirectory));
            assert.equal(
                localToolsDirectory,
                path.join(localDesktopPaths().cargo, ".tauri"),
            );
        },
        async buildTauri(args, { environment }) {
            calls.push("build");
            const overlay = JSON.parse(args[args.indexOf("--config") + 1]);
            assert.equal(overlay.bundle.useLocalToolsDir, true);
            assert.equal(
                environment.LDAI_RUNTIME_FILE,
                path.join(
                    localDesktopPaths().cargo,
                    ".tauri",
                    "runtime-x86_64",
                ),
            );
        },
    });
    assert.deepEqual(calls, ["prepare", "resolve", "stage", "build"]);
    await buildLocalDesktop(["--bundle", "--bundles", "deb"], {
        platform: "linux",
        environment: {},
        prepareLinuxTools() {
            assert.fail("Deb packaging does not invoke AppImage tools");
        },
        async buildTauri() {},
    });
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
