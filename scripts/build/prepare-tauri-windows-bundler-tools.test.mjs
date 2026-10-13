import { TAURI_LOCAL_TOOLS_DIRECTORY_NAME } from "./build-tauri.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
    preparePinnedTauriWindowsBundlerTools,
    buildPinnedTauriWindowsBundle,
    validateWindowsToolsManifest,
    WINDOWS_BUNDLE_CONFIG,
    WINDOWS_NSIS_REQUIRED_FILES,
    WINDOWS_NSIS_ARCHIVE,
    WINDOWS_NSIS_DIRECTORY,
    WINDOWS_NSIS_PLUGIN,
    WINDOWS_NSIS_PLUGIN_RELATIVE_PATH,
} from "./prepare-tauri-windows-bundler-tools.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const manifest = JSON.parse(
    await readFile(
        path.join(root, "config", "tauri-windows-bundler-tools.json"),
        "utf8",
    ),
);
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const cliVersion = pkg.devDependencies["@tauri-apps/cli"];

test("Windows installer inputs match the pinned CLI and reject incomplete or fresh admissions", () => {
    assert.equal(validateWindowsToolsManifest(manifest, cliVersion).length, 2);
    for (const modified of [
        { ...manifest, minimumAgeDays: 0 },
        { ...manifest, tauriCliVersion: "latest" },
        { ...manifest, tools: [manifest.tools[0], manifest.tools[0]] },
        { ...manifest, tools: manifest.tools.slice(1) },
        {
            ...manifest,
            tools: manifest.tools.map((tool) => ({
                ...tool,
                publishedAt: "2099-01-01T00:00:00Z",
            })),
        },
        {
            ...manifest,
            tools: manifest.tools.map((tool) => ({
                ...tool,
                url: "https://example.org/latest",
            })),
        },
    ])
        assert.throws(() => validateWindowsToolsManifest(modified, cliVersion));
    assert.equal(WINDOWS_BUNDLE_CONFIG.bundle.useLocalToolsDir, true);
    assert.deepEqual(WINDOWS_BUNDLE_CONFIG.bundle.windows.webviewInstallMode, {
        type: "skip",
    });
});

test("cached bytes are verified and NSIS execution copies are refreshed under Cargo's target root", async () => {
    await mkdir(path.join(root, "tmp"), { recursive: true });
    const fixtureRoot = await mkdtemp(
        path.join(root, "tmp", "windows-tools-test-"),
    );
    const cacheRoot = path.join(
        fixtureRoot,
        ".cache",
        "desktop-windows-bundler",
    );
    await mkdir(cacheRoot, { recursive: true });
    await mkdir(path.join(fixtureRoot, "config"));
    await writeFile(
        path.join(fixtureRoot, "package.json"),
        JSON.stringify(pkg),
    );
    const fixtureManifest = structuredClone(manifest);
    for (const tool of fixtureManifest.tools) {
        const bytes = Buffer.from(`reviewed ${tool.fileName}`);
        tool.sizeBytes = bytes.length;
        tool.sha256 = createHash("sha256").update(bytes).digest("hex");
        await writeFile(path.join(cacheRoot, tool.fileName), bytes);
    }
    await writeFile(
        path.join(fixtureRoot, "config", "tauri-windows-bundler-tools.json"),
        JSON.stringify(fixtureManifest),
    );
    const targetRoot = path.join(fixtureRoot, "configured target");
    const previousRoot = path.join(
        targetRoot,
        TAURI_LOCAL_TOOLS_DIRECTORY_NAME,
        WINDOWS_NSIS_DIRECTORY,
    );
    await mkdir(previousRoot, { recursive: true });
    await writeFile(path.join(previousRoot, "unreviewed.exe"), "stale");
    let builds = 0;
    const options = {
        platform: "win32",
        resolveCliEntrypoint: () => "fixture-tauri.js",
        projectRoot: fixtureRoot,
        fetchImplementation() {
            throw new Error("Verified cache must work offline");
        },
        async runCommand(command, args) {
            if (command === process.execPath) {
                builds++;
                assert.equal(
                    args.filter((arg) => arg === "--locked").length,
                    1,
                );
                assert.ok(args.includes("--no-sign"));
                assert.equal(args[args.indexOf("--bundles") + 1], "nsis");
                assert.deepEqual(
                    JSON.parse(args[args.indexOf("--config") + 1]),
                    WINDOWS_BUNDLE_CONFIG,
                );
                return { stdout: "" };
            }
            if (command === "cargo")
                return {
                    stdout: JSON.stringify({ target_directory: targetRoot }),
                };
            assert.equal(command, "powershell.exe");
            assert.ok(args.at(-1).includes(WINDOWS_NSIS_ARCHIVE));
            const extractionPath = args
                .at(-1)
                .match(/-DestinationPath '([^']+)'$/)[1];
            for (const name of WINDOWS_NSIS_REQUIRED_FILES.filter(
                (name) => !name.endsWith(WINDOWS_NSIS_PLUGIN),
            )) {
                const filePath = path.join(extractionPath, "nsis-3.11", name);
                await mkdir(path.dirname(filePath), { recursive: true });
                await writeFile(filePath, "archive file");
            }
            return { stdout: "" };
        },
    };
    const prepared = await preparePinnedTauriWindowsBundlerTools(options);
    assert.equal(prepared.nsisRoot, previousRoot);
    await assert.rejects(readFile(path.join(previousRoot, "unreviewed.exe")), {
        code: "ENOENT",
    });
    assert.equal(
        await readFile(
            path.join(previousRoot, WINDOWS_NSIS_PLUGIN_RELATIVE_PATH),
            "utf8",
        ),
        `reviewed ${WINDOWS_NSIS_PLUGIN}`,
    );
    await buildPinnedTauriWindowsBundle(options);
    assert.equal(builds, 1);
    await writeFile(path.join(cacheRoot, WINDOWS_NSIS_ARCHIVE), "corrupt");
    await assert.rejects(
        buildPinnedTauriWindowsBundle(options),
        /request failed before receiving a response/,
    );
    assert.equal(builds, 1, "A corrupted input never reaches Tauri");
});
