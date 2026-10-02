import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
    symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
    TAURI_LINUX_APPIMAGE_RUNTIME_ENV_KEY,
    TAURI_LINUX_APPIMAGE_RUNTIME_FILE_NAME,
    TAURI_LINUX_APPIMAGE_OUTPUT_PLUGIN_FILE_NAME,
    TAURI_LINUX_APPIMAGE_PINNED_PLUGIN_FILE_NAME,
    TAURI_LINUX_BUNDLER_TARGET,
    TAURI_LINUX_BUNDLER_TOOL_FILE_NAMES,
    TAURI_LOCAL_TOOLS_DIRECTORY_NAME,
    buildPinnedTauriLinuxBundle,
    preparePinnedTauriLinuxBundlerTools,
    resolveTauriToolsCacheDirectory,
    resolveTauriLocalToolsDirectory,
    stageTauriLinuxBundleTools,
    validatePinnedToolsManifest,
} from "./prepare-tauri-linux-bundler-tools.mjs";
import { runRedactedCommand } from "./secret-output-redaction.mjs";

const testCliVersion = "2.11.3-test";
const testPublishedAt = "2025-01-01T00:00:00Z";

test("uses Rust dirs cache semantics for relative paths and whitespace", () => {
    for (const XDG_CACHE_HOME of [undefined, "", "relative/cache", "   "]) {
        assert.equal(
            resolveTauriToolsCacheDirectory({ XDG_CACHE_HOME }),
            path.join(os.homedir(), ".cache", "tauri"),
        );
    }
    const cacheRoot = path.join(os.tmpdir(), "cache root ");
    assert.equal(
        resolveTauriToolsCacheDirectory({ XDG_CACHE_HOME: cacheRoot }),
        path.join(cacheRoot, "tauri"),
    );
});

test("the checked-in tool manifest passes the real CLI and age policy", async () => {
    const manifest = JSON.parse(
        await readFile(
            new URL(
                "../../config/tauri-linux-bundler-tools.json",
                import.meta.url,
            ),
            "utf8",
        ),
    );
    const packageManifest = JSON.parse(
        await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    );
    // Check the repository's serialized package/manifest boundary before CI downloads tools.
    assert.equal(
        validatePinnedToolsManifest(
            manifest,
            packageManifest.devDependencies["@tauri-apps/cli"],
        ).length,
        TAURI_LINUX_BUNDLER_TOOL_FILE_NAMES.length,
    );
});

function createTestManifest() {
    return {
        schemaVersion: 2,
        minimumAgeDays: 30,
        tauriCliVersion: testCliVersion,
        tauriBundlerVersion: "test",
        target: "x86_64-unknown-linux-gnu",
        tools: TAURI_LINUX_BUNDLER_TOOL_FILE_NAMES.map((fileName, index) => {
            const content = Buffer.from(`pinned-tool-${index}-${fileName}`);
            const sourceRevision = fileName.endsWith(".sh")
                ? String(index + 1).padStart(40, "a")
                : "a".repeat(40);
            return {
                fileName,
                sourceRevision,
                publishedAt: testPublishedAt,
                ...(fileName.endsWith(".sh")
                    ? {}
                    : { releaseTag: "v1.0.0", assetName: fileName }),
                url: fileName.endsWith(".sh")
                    ? `https://raw.githubusercontent.com/example/tools/${sourceRevision}/${fileName}`
                    : `https://api.github.com/repos/example/tools/releases/assets/${index + 1}`,
                sizeBytes: content.length,
                sha256: sha256(content),
                content,
            };
        }),
    };
}

function serializableManifest(manifest) {
    return {
        ...manifest,
        tools: manifest.tools.map(({ content: _content, ...tool }) => tool),
    };
}

test("requires the complete Tauri Linux bundler tool set", () => {
    const manifest = serializableManifest(createTestManifest());
    manifest.tools.pop();

    assert.throws(
        () => validatePinnedToolsManifest(manifest, testCliVersion),
        /tool set mismatch/,
    );
});

test("rejects continuous provenance even behind a fixed asset ID", () => {
    const manifest = serializableManifest(createTestManifest());
    manifest.tools[0].releaseTag = "continuous";
    assert.throws(
        () => validatePinnedToolsManifest(manifest, testCliVersion),
        /retained release/,
    );
});

test("enforces the full 30-day age boundary and rejects a weakened policy", () => {
    const manifest = serializableManifest(createTestManifest());
    assert.equal(
        validatePinnedToolsManifest(
            manifest,
            testCliVersion,
            new Date("2025-01-31T00:00:00Z"),
        ).length,
        manifest.tools.length,
    );
    assert.throws(
        () =>
            validatePinnedToolsManifest(
                manifest,
                testCliVersion,
                new Date("2025-01-30T23:59:59Z"),
            ),
        /30-day age gate/,
    );
    for (const minimumAgeDays of [0, 1e30, Number.MAX_SAFE_INTEGER]) {
        manifest.minimumAgeDays = minimumAgeDays;
        assert.throws(
            () => validatePinnedToolsManifest(manifest, testCliVersion),
            /at least 30 days|invalid age cutoff/,
        );
    }
});

test("rejects missing or invalid publication evidence", () => {
    for (const publishedAt of [undefined, "2025-02-30T00:00:00Z", "invalid"]) {
        const manifest = serializableManifest(createTestManifest());
        manifest.tools[0].publishedAt = publishedAt;
        assert.throws(
            () => validatePinnedToolsManifest(manifest, testCliVersion),
            /publication timestamp/,
        );
    }
});

test("rejects binary URLs that resolve a moving release tag", () => {
    const manifest = serializableManifest(createTestManifest());
    const tool = manifest.tools.find((tool) => !tool.fileName.endsWith(".sh"));
    tool.url = `https://github.com/example/tools/releases/download/continuous/${tool.fileName}`;

    assert.throws(
        () => validatePinnedToolsManifest(manifest, testCliVersion),
        /release asset ID/,
    );
});

test("requires script URLs to select their declared source revision", () => {
    const manifest = serializableManifest(createTestManifest());
    const tool = manifest.tools.find((tool) => tool.fileName.endsWith(".sh"));
    tool.url = tool.url.replace(tool.sourceRevision, "main");

    assert.throws(
        () => validatePinnedToolsManifest(manifest, testCliVersion),
        /source revision/,
    );
});

test("downloads, verifies, and reuses only pinned executable bytes", async () => {
    const temporaryRoot = await mkdtemp(
        path.join(os.tmpdir(), "artgod-tauri-tools-test-"),
    );
    const cacheDirectory = path.join(temporaryRoot, "cache");
    const manifestPath = path.join(temporaryRoot, "manifest.json");
    const manifest = createTestManifest();
    const contentByUrl = new Map(
        manifest.tools.map((tool) => [tool.url, tool.content]),
    );
    let fetchCount = 0;
    const fetchImplementation = async (url, options) => {
        fetchCount += 1;
        if (isMetadataRequest(options)) {
            return testMetadataResponse(manifest, url);
        }
        // Assert GitHub's wire contract: asset APIs return metadata without this header.
        assert.equal(
            new Headers(options?.headers).get("accept"),
            "application/octet-stream",
        );
        const content = contentByUrl.get(url);
        return new Response(content, { status: content ? 200 : 404 });
    };

    try {
        await writeFile(
            manifestPath,
            `${JSON.stringify(serializableManifest(manifest), null, 4)}\n`,
        );
        await preparePinnedTauriLinuxBundlerTools({
            manifestPath,
            cacheDirectory,
            expectedTauriCliVersion: testCliVersion,
            fetchImplementation,
            logger: () => {},
        });

        assert.equal(fetchCount, manifest.tools.length * 2);
        for (const tool of manifest.tools) {
            const filePath = path.join(cacheDirectory, tool.fileName);
            assert.deepEqual(await readFile(filePath), tool.content);
            assert.equal((await stat(filePath)).mode & 0o777, 0o755);
        }

        await preparePinnedTauriLinuxBundlerTools({
            manifestPath,
            cacheDirectory,
            expectedTauriCliVersion: testCliVersion,
            fetchImplementation,
            logger: () => {},
        });
        assert.equal(fetchCount, manifest.tools.length * 2);

        const replacedTool = manifest.tools[0];
        await writeFile(
            path.join(cacheDirectory, replacedTool.fileName),
            "mutated-by-bundler",
        );
        await preparePinnedTauriLinuxBundlerTools({
            manifestPath,
            cacheDirectory,
            expectedTauriCliVersion: testCliVersion,
            fetchImplementation,
            logger: () => {},
        });
        assert.equal(fetchCount, manifest.tools.length * 2 + 2);
        assert.deepEqual(
            await readFile(path.join(cacheDirectory, replacedTool.fileName)),
            replacedTool.content,
        );
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});

test("rejects downloaded bytes before they reach Tauri's executable cache", async () => {
    const temporaryRoot = await mkdtemp(
        path.join(os.tmpdir(), "artgod-tauri-tools-mismatch-test-"),
    );
    const cacheDirectory = path.join(temporaryRoot, "cache");
    const manifestPath = path.join(temporaryRoot, "manifest.json");
    const manifest = createTestManifest();

    try {
        await writeFile(
            manifestPath,
            `${JSON.stringify(serializableManifest(manifest), null, 4)}\n`,
        );
        await assert.rejects(
            preparePinnedTauriLinuxBundlerTools({
                manifestPath,
                cacheDirectory,
                expectedTauriCliVersion: testCliVersion,
                fetchImplementation: async (url, options) => {
                    if (isMetadataRequest(options)) {
                        return testMetadataResponse(manifest, url);
                    }
                    // Match the pinned size so only the digest detects changed bytes.
                    const content = Buffer.from(manifest.tools[0].content);
                    content[0] ^= 1;
                    return new Response(content, { status: 200 });
                },
                logger: () => {},
            }),
            /SHA-256 mismatch/,
        );
        await assert.rejects(
            stat(
                path.join(
                    cacheDirectory,
                    TAURI_LINUX_BUNDLER_TOOL_FILE_NAMES[0],
                ),
            ),
            { code: "ENOENT" },
        );
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});

test("rejects a new upload attached to an old release before downloading it", async () => {
    const temporaryRoot = await mkdtemp(
        path.join(os.tmpdir(), "artgod-tauri-tools-provenance-test-"),
    );
    const manifestPath = path.join(temporaryRoot, "manifest.json");
    const manifest = createTestManifest();
    let binaryDownloads = 0;
    try {
        await writeFile(
            manifestPath,
            JSON.stringify(serializableManifest(manifest)),
        );
        await assert.rejects(
            preparePinnedTauriLinuxBundlerTools({
                manifestPath,
                cacheDirectory: path.join(temporaryRoot, "cache"),
                expectedTauriCliVersion: testCliVersion,
                fetchImplementation: async (url, options) => {
                    if (!isMetadataRequest(options)) {
                        binaryDownloads += 1;
                        return new Response(manifest.tools[0].content);
                    }
                    const metadata = await testMetadataResponse(
                        manifest,
                        url,
                    ).json();
                    metadata.assets[0].updated_at = "2026-10-01T00:00:00Z";
                    return Response.json(metadata);
                },
                logger: () => {},
            }),
            /publication timestamp mismatch/,
        );
        assert.equal(binaryDownloads, 0);
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});

test("checks that a fixed asset actually belongs to the declared release", async () => {
    const temporaryRoot = await mkdtemp(
        path.join(os.tmpdir(), "artgod-tauri-tools-release-test-"),
    );
    const manifestPath = path.join(temporaryRoot, "manifest.json");
    const manifest = createTestManifest();
    try {
        await writeFile(
            manifestPath,
            JSON.stringify(serializableManifest(manifest)),
        );
        await assert.rejects(
            preparePinnedTauriLinuxBundlerTools({
                manifestPath,
                cacheDirectory: path.join(temporaryRoot, "cache"),
                expectedTauriCliVersion: testCliVersion,
                fetchImplementation: async () =>
                    Response.json({
                        tag_name: "v1.0.0",
                        draft: false,
                        published_at: testPublishedAt,
                        assets: [],
                    }),
                logger: () => {},
            }),
            /release asset metadata mismatch/,
        );
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});

function isMetadataRequest(options) {
    return (
        new Headers(options?.headers).get("accept") ===
        "application/vnd.github+json"
    );
}

test("rejects a changed release revision or upstream digest before downloading", async () => {
    const temporaryRoot = await mkdtemp(
        path.join(os.tmpdir(), "artgod-tauri-tools-metadata-test-"),
    );
    const manifestPath = path.join(temporaryRoot, "manifest.json");
    const manifest = createTestManifest();
    let binaryDownloads = 0;
    try {
        await writeFile(
            manifestPath,
            JSON.stringify(serializableManifest(manifest)),
        );
        for (const mutate of [
            (metadata) => {
                metadata.target_commitish = "b".repeat(40);
            },
            (metadata) => {
                metadata.assets[0].digest = `sha256:${"b".repeat(64)}`;
            },
        ]) {
            await assert.rejects(
                preparePinnedTauriLinuxBundlerTools({
                    manifestPath,
                    cacheDirectory: path.join(temporaryRoot, "cache"),
                    expectedTauriCliVersion: testCliVersion,
                    logger: () => {},
                    fetchImplementation: async (url, options) => {
                        if (!isMetadataRequest(options)) {
                            binaryDownloads += 1;
                            return new Response(manifest.tools[0].content);
                        }
                        const metadata = await testMetadataResponse(
                            manifest,
                            url,
                        ).json();
                        mutate(metadata);
                        return Response.json(metadata);
                    },
                }),
                /release asset metadata mismatch/,
            );
        }
        assert.equal(binaryDownloads, 0);
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});

test("resolves Tauri's local tools from Cargo metadata with the caller's environment", async () => {
    const environment = { CARGO_TARGET_DIR: "custom-target" };
    const targetDirectory = path.resolve("custom Cargo target");
    const localToolsDirectory = await resolveTauriLocalToolsDirectory({
        environment,
        async runCommand(command, args, options) {
            assert.equal(command, "cargo");
            assert.deepEqual(args, [
                "metadata",
                "--no-deps",
                "--format-version",
                "1",
                "--locked",
            ]);
            assert.equal(
                options.cwd,
                fileURLToPath(new URL("../../src-tauri", import.meta.url)),
            );
            assert.equal(options.env, environment);
            return {
                stdout: JSON.stringify({ target_directory: targetDirectory }),
            };
        },
    });
    assert.equal(
        localToolsDirectory,
        path.join(targetDirectory, TAURI_LOCAL_TOOLS_DIRECTORY_NAME),
    );
});

test("rejects missing or relative Cargo target directories without guessing a fallback", async () => {
    for (const targetDirectory of [undefined, null, 1, "", "relative-target"]) {
        await assert.rejects(
            resolveTauriLocalToolsDirectory({
                runCommand: async () => ({
                    stdout: JSON.stringify({
                        target_directory: targetDirectory,
                    }),
                }),
            }),
            /absolute target_directory/,
        );
    }
});

test("refreshes local execution tools for repeated locked builds without redirecting other caches", async () => {
    const fixture = await createBundleTestFixture();
    const { manifest, cacheDirectory, targetDirectory } = fixture;
    const localToolsDirectory = path.join(
        targetDirectory,
        TAURI_LOCAL_TOOLS_DIRECTORY_NAME,
    );
    const environment = {
        XDG_CACHE_HOME: path.join(fixture.temporaryRoot, "original-xdg-cache"),
        COREPACK_HOME: path.join(
            fixture.temporaryRoot,
            "original-corepack-cache",
        ),
        CARGO_TARGET_DIR: targetDirectory,
        [TAURI_LINUX_APPIMAGE_RUNTIME_ENV_KEY]: "/unverified/runtime",
    };
    await mkdir(localToolsDirectory, { recursive: true });
    const unrelatedTool = path.join(localToolsDirectory, "other-platform-tool");
    await writeFile(unrelatedTool, "preserve unrelated tools");
    // An old execution entry must not redirect a refresh into verified originals.
    const linkedTool = TAURI_LINUX_BUNDLER_TOOL_FILE_NAMES[1];
    await symlink(
        path.join(cacheDirectory, linkedTool),
        path.join(localToolsDirectory, linkedTool),
    );
    let buildCount = 0;
    for (let iteration = 0; iteration < 2; iteration += 1) {
        await buildPinnedTauriLinuxBundle({
            ...fixture.buildOptions,
            environment,
            runCommand: fixture.runCargoMetadata,
            runBuild: async (command, args, options) => {
                buildCount += 1;
                assert.equal(command, "yarn");
                assert.equal(
                    args[args.indexOf("--target") + 1],
                    TAURI_LINUX_BUNDLER_TARGET,
                );
                assert.deepEqual(args.slice(-2), ["--", "--locked"]);
                assert.deepEqual(
                    JSON.parse(args[args.indexOf("--config") + 1]),
                    {
                        bundle: { useLocalToolsDir: true },
                    },
                );
                const runtimePath = path.join(
                    localToolsDirectory,
                    TAURI_LINUX_APPIMAGE_RUNTIME_FILE_NAME,
                );
                assert.deepEqual(options.env, {
                    ...environment,
                    [TAURI_LINUX_APPIMAGE_RUNTIME_ENV_KEY]: runtimePath,
                });
                for (const tool of manifest.tools) {
                    const executionPath = path.join(
                        localToolsDirectory,
                        tool.fileName ===
                            TAURI_LINUX_APPIMAGE_OUTPUT_PLUGIN_FILE_NAME
                            ? TAURI_LINUX_APPIMAGE_PINNED_PLUGIN_FILE_NAME
                            : tool.fileName,
                    );
                    assert.deepEqual(
                        await readFile(executionPath),
                        tool.content,
                    );
                    assert.equal(
                        (await stat(executionPath)).mode & 0o777,
                        0o755,
                    );
                }
                const adapterPath = path.join(
                    localToolsDirectory,
                    TAURI_LINUX_APPIMAGE_OUTPUT_PLUGIN_FILE_NAME,
                );
                assert.match(
                    await readFile(adapterPath, "utf8"),
                    /linux-appimage-host-libraries\.mjs/,
                );
                assert.equal((await stat(adapterPath)).mode & 0o777, 0o755);
                await assert.rejects(
                    readFile(path.join(localToolsDirectory, "package.json")),
                    { code: "ENOENT" },
                );
                // Model Tauri's mutation and an interrupted prior build.
                await writeFile(
                    path.join(localToolsDirectory, linkedTool),
                    "mutated linuxdeploy",
                );
                await rm(runtimePath);
                await writeFile(adapterPath, "stale adapter");
                await writeFile(
                    path.join(
                        localToolsDirectory,
                        TAURI_LINUX_APPIMAGE_PINNED_PLUGIN_FILE_NAME,
                    ),
                    "stale plugin",
                );
            },
        });
    }
    assert.equal(buildCount, 2);
    assert.equal(
        await readFile(unrelatedTool, "utf8"),
        "preserve unrelated tools",
    );
    for (const tool of manifest.tools) {
        assert.deepEqual(
            await readFile(path.join(cacheDirectory, tool.fileName)),
            tool.content,
        );
    }
});

test("Corepack keeps using its original cache while local tools are inside an ESM project", async () => {
    const fixture = await createBundleTestFixture();
    const rootPackage = JSON.parse(
        await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    );
    const yarnVersion = rootPackage.packageManager.match(
        /^yarn@(\d+\.\d+\.\d+)/,
    )?.[1];
    assert.ok(yarnVersion, "The project must pin a Yarn version.");
    // Model the normal external cache scope and a nested ESM project entirely
    // inside this worktree's retained fixture directory.
    await writeFile(
        path.join(fixture.temporaryRoot, "package.json"),
        JSON.stringify({ type: "commonjs" }),
    );
    const projectDirectory = path.join(fixture.temporaryRoot, "esm-project");
    await mkdir(projectDirectory);
    await writeFile(
        path.join(projectDirectory, "package.json"),
        JSON.stringify({
            type: "module",
            packageManager: rootPackage.packageManager,
        }),
    );
    const environment = {
        ...process.env,
        XDG_CACHE_HOME: path.join(fixture.temporaryRoot, "original-cache"),
        CARGO_TARGET_DIR: path.join(projectDirectory, "target"),
        COREPACK_ENABLE_NETWORK: "0",
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
        COREPACK_DEFAULT_TO_LATEST: "0",
    };
    delete environment.COREPACK_HOME;
    const installFolder = path.join(
        environment.XDG_CACHE_HOME,
        "node/corepack/v1/yarn",
        yarnVersion,
    );
    await mkdir(installFolder, { recursive: true });
    // Run the CommonJS require boundary through the real Corepack launcher.
    const cliSource = [
        'const load = typeof require === "function" ? require : (name) => {',
        '    throw new Error(`Dynamic require of "${name}" is not supported`);',
        "};",
        'load("util");',
        `console.log(${JSON.stringify(yarnVersion)});`,
    ].join("\n");
    await writeFile(path.join(installFolder, "yarn.js"), cliSource);
    await writeFile(
        path.join(installFolder, ".corepack"),
        JSON.stringify({
            locator: { name: "yarn", reference: yarnVersion },
            bin: ["yarn", "yarnpkg"],
            hash: `sha512.${createHash("sha512").update(cliSource).digest("hex")}`,
        }),
    );
    await buildPinnedTauriLinuxBundle({
        ...fixture.buildOptions,
        environment,
        runCommand: async () => ({
            stdout: JSON.stringify({
                target_directory: environment.CARGO_TARGET_DIR,
            }),
        }),
        async runBuild(_command, _args, options) {
            assert.equal(
                options.env.XDG_CACHE_HOME,
                environment.XDG_CACHE_HOME,
            );
            const result = await runRedactedCommand(
                "corepack",
                ["yarn", "--version"],
                {
                    cwd: projectDirectory,
                    env: options.env,
                },
            );
            assert.equal(result.stdout.trim(), yarnVersion);
        },
    });
});

test("never launches Tauri when target resolution or execution-tool refresh fails", async () => {
    const fixture = await createBundleTestFixture();
    let launched = false;
    const buildOptions = {
        ...fixture.buildOptions,
        runBuild: async () => {
            launched = true;
        },
    };
    await assert.rejects(
        buildPinnedTauriLinuxBundle({
            ...buildOptions,
            runCommand: async () => {
                throw new Error("Cargo metadata failed");
            },
        }),
        /Cargo metadata failed/,
    );
    const localToolsDirectory = path.join(
        fixture.targetDirectory,
        TAURI_LOCAL_TOOLS_DIRECTORY_NAME,
    );
    await mkdir(
        path.join(localToolsDirectory, TAURI_LINUX_BUNDLER_TOOL_FILE_NAMES[0]),
        { recursive: true },
    );
    await assert.rejects(
        buildPinnedTauriLinuxBundle({
            ...buildOptions,
            runCommand: fixture.runCargoMetadata,
        }),
        { code: "ERR_FS_EISDIR" },
    );
    assert.equal(launched, false);
});

test("rejects execution-directory aliases of the verified input cache", async () => {
    const fixture = await createBundleTestFixture();
    await assert.rejects(
        stageTauriLinuxBundleTools({
            cacheDirectory: fixture.cacheDirectory,
            localToolsDirectory: fixture.cacheDirectory,
        }),
        /separate from the verified cache/,
    );
    const localToolsDirectory = path.join(
        fixture.temporaryRoot,
        TAURI_LOCAL_TOOLS_DIRECTORY_NAME,
    );
    await symlink(fixture.cacheDirectory, localToolsDirectory);
    await assert.rejects(
        stageTauriLinuxBundleTools({
            cacheDirectory: fixture.cacheDirectory,
            localToolsDirectory,
        }),
        /not a link/,
    );
    for (const tool of fixture.manifest.tools) {
        assert.deepEqual(
            await readFile(path.join(fixture.cacheDirectory, tool.fileName)),
            tool.content,
        );
    }
});

async function createBundleTestFixture() {
    const fixtureRoot = fileURLToPath(new URL("../../tmp", import.meta.url));
    await mkdir(fixtureRoot, { recursive: true });
    const temporaryRoot = await mkdtemp(
        path.join(fixtureRoot, "tauri-local-tools-test-"),
    );
    const manifestPath = path.join(temporaryRoot, "manifest.json");
    const manifest = createTestManifest();
    const cacheDirectory = path.join(temporaryRoot, "verified/tauri");
    const targetDirectory = path.join(temporaryRoot, "Cargo target");
    await writeFile(
        manifestPath,
        JSON.stringify(serializableManifest(manifest)),
    );
    await mkdir(cacheDirectory, { recursive: true });
    for (const tool of manifest.tools) {
        await writeFile(path.join(cacheDirectory, tool.fileName), tool.content);
    }
    return {
        temporaryRoot,
        manifest,
        cacheDirectory,
        targetDirectory,
        runCargoMetadata: async () => ({
            stdout: JSON.stringify({ target_directory: targetDirectory }),
        }),
        buildOptions: {
            manifestPath,
            cacheDirectory,
            expectedTauriCliVersion: testCliVersion,
            logger: () => {},
            fetchImplementation: async () => {
                throw new Error("Verified cache must work offline.");
            },
        },
    };
}

test("never launches Tauri when input verification fails", async () => {
    const temporaryRoot = await mkdtemp(
        path.join(os.tmpdir(), "artgod-tauri-tools-blocked-build-test-"),
    );
    const manifestPath = path.join(temporaryRoot, "manifest.json");
    const manifest = serializableManifest(createTestManifest());
    manifest.tools.at(-1).releaseTag = "continuous";
    let launched = false;
    try {
        await writeFile(manifestPath, JSON.stringify(manifest));
        await assert.rejects(
            buildPinnedTauriLinuxBundle({
                manifestPath,
                cacheDirectory: path.join(temporaryRoot, "tauri"),
                expectedTauriCliVersion: testCliVersion,
                runBuild: async () => {
                    launched = true;
                },
            }),
            /retained release/,
        );
        assert.equal(launched, false);
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});

function testMetadataResponse(manifest, url) {
    const revision = url.match(/\/commits\/([a-f0-9]{40})$/)?.[1];
    if (revision) {
        return Response.json({
            sha: revision,
            commit: { committer: { date: testPublishedAt } },
        });
    }
    return Response.json({
        tag_name: "v1.0.0",
        target_commitish: manifest.tools[0].sourceRevision,
        draft: false,
        published_at: testPublishedAt,
        assets: manifest.tools
            .filter((tool) => !tool.fileName.endsWith(".sh"))
            .map((tool) => ({
                id: Number(new URL(tool.url).pathname.split("/").at(-1)),
                name: tool.assetName,
                size: tool.sizeBytes,
                digest: `sha256:${tool.sha256}`,
                created_at: testPublishedAt,
                updated_at: testPublishedAt,
            })),
    });
}

function sha256(content) {
    return createHash("sha256").update(content).digest("hex");
}
