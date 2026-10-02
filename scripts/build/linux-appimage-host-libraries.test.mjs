import assert from "node:assert/strict";
import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    omitAppImageHostLibraries,
    verifyAppImageHostLibraries,
} from "./linux-appimage-host-libraries.mjs";
import {
    stageTauriLinuxBundleTools,
    TAURI_LINUX_APPIMAGE_OUTPUT_PLUGIN_FILE_NAME,
    TAURI_LINUX_APPIMAGE_RUNTIME_ENV_KEY,
    TAURI_LINUX_BUNDLER_TOOL_FILE_NAMES,
} from "./prepare-tauri-linux-bundler-tools.mjs";
import { runRedactedCommand } from "./secret-output-redaction.mjs";

test("omits Wayland files and links across native library layouts, preserving WebKit", async () => {
    await withAppDir(async ({ appDir, temporaryRoot }) => {
        const libraries = [
            "usr/lib/libwayland-client.so.0.20.0",
            "usr/lib/x86_64-linux-gnu/libwayland-server.so.0",
            "usr/lib64/libwayland-cursor.so.0",
            "lib/libwayland-egl.so.1",
        ];
        for (const library of libraries) {
            await writeFixtureFile(path.join(appDir, library), "old-wayland");
        }
        await symlink(
            "libwayland-client.so.0.20.0",
            path.join(appDir, "usr/lib/libwayland-client.so.0"),
        );
        await writeFixtureFile(
            path.join(appDir, "usr/lib/libwebkit2gtk-4.1.so.0"),
            "webkit",
        );
        const hostLibrary = path.join(
            temporaryRoot,
            "host/libwayland-client.so.0",
        );
        await writeFixtureFile(hostLibrary, "host-wayland");
        await symlink(
            path.dirname(hostLibrary),
            path.join(appDir, "usr/host-libs"),
        );

        assert.deepEqual(
            await omitAppImageHostLibraries(appDir),
            [...libraries, "usr/lib/libwayland-client.so.0"].sort(),
        );
        await verifyAppImageHostLibraries(appDir);
        assert.equal(await readFile(hostLibrary, "utf8"), "host-wayland");
        assert.equal(
            await readFile(
                path.join(appDir, "usr/lib/libwebkit2gtk-4.1.so.0"),
                "utf8",
            ),
            "webkit",
        );
        assert.deepEqual(await omitAppImageHostLibraries(appDir), []);
    });
});

test("rejects bundled Wayland files and symbolic links in the finished artifact", async () => {
    await withAppDir(async ({ appDir }) => {
        const library = path.join(appDir, "usr/lib/libwayland-client.so.0");
        await writeFixtureFile(library, "old-wayland");
        await assert.rejects(
            verifyAppImageHostLibraries(appDir),
            /bundled copies found: usr\/lib\/libwayland-client\.so\.0/,
        );
        await rm(library);
        await symlink("missing-library", library);
        await assert.rejects(
            verifyAppImageHostLibraries(appDir),
            /bundled copies found/,
        );
    });
});

test("does not modify an invalid or symlinked AppDir", async () => {
    await withAppDir(async ({ appDir, temporaryRoot }) => {
        const library = path.join(appDir, "usr/lib/libwayland-client.so.0");
        await writeFixtureFile(library, "old-wayland");
        const linkedAppDir = path.join(temporaryRoot, "linked.AppDir");
        await symlink(appDir, linkedAppDir);
        await assert.rejects(
            omitAppImageHostLibraries(linkedAppDir),
            /requires a directory/,
        );
        await rm(path.join(appDir, "AppRun"));
        await assert.rejects(omitAppImageHostLibraries(appDir), /ENOENT/);
        assert.equal(await readFile(library, "utf8"), "old-wayland");
    });
});

test("output adapter forwards probes, applies policy before packing, and preserves pinned bytes", async () => {
    await withAppDir(async ({ appDir, temporaryRoot }) => {
        const cacheDirectory = path.join(temporaryRoot, "verified/tauri");
        await mkdir(cacheDirectory, { recursive: true });
        const pinnedPlugin = [
            "#!/bin/sh",
            'case "$1" in',
            '  --plugin-api-version) printf "0\\n" ;;',
            '  --plugin-type) printf "output\\n" ;;',
            '  --appdir) test ! -e "$2/usr/lib/libwayland-client.so.0" || exit 9',
            `    printf "%s" "$${TAURI_LINUX_APPIMAGE_RUNTIME_ENV_KEY}" > "$2/packed-runtime.txt"`,
            '    exit "${TEST_PLUGIN_EXIT_CODE:-0}" ;;',
            "  *) exit 8 ;;",
            "esac",
            "",
        ].join("\n");
        for (const fileName of TAURI_LINUX_BUNDLER_TOOL_FILE_NAMES) {
            const toolPath = path.join(cacheDirectory, fileName);
            await writeFile(
                toolPath,
                fileName === TAURI_LINUX_APPIMAGE_OUTPUT_PLUGIN_FILE_NAME
                    ? pinnedPlugin
                    : fileName,
            );
            await chmod(toolPath, 0o755);
        }
        // Exercise shell quoting in generated paths without executing their text.
        const buildCacheDirectory = await stageTauriLinuxBundleTools({
            cacheDirectory,
            temporaryRoot: path.join(temporaryRoot, "build ' $(literal)"),
        });
        const adapter = path.join(
            buildCacheDirectory,
            TAURI_LINUX_APPIMAGE_OUTPUT_PLUGIN_FILE_NAME,
        );
        const environment = {
            ...process.env,
            [TAURI_LINUX_APPIMAGE_RUNTIME_ENV_KEY]: "verified-runtime",
        };
        for (const [probe, expected] of [
            ["--plugin-api-version", "0\n"],
            ["--plugin-type", "output\n"],
        ]) {
            const result = await runRedactedCommand(adapter, [probe], {
                env: environment,
            });
            assert.equal(result.stdout, expected);
        }
        // Represents a dependency reintroduced by the GTK input plugin.
        await writeFixtureFile(
            path.join(appDir, "usr/lib/libwayland-client.so.0"),
            "old-wayland",
        );
        await runRedactedCommand(adapter, ["--appdir", appDir], {
            env: environment,
        });
        assert.equal(
            await readFile(path.join(appDir, "packed-runtime.txt"), "utf8"),
            environment[TAURI_LINUX_APPIMAGE_RUNTIME_ENV_KEY],
        );
        assert.equal(
            await readFile(
                path.join(
                    cacheDirectory,
                    TAURI_LINUX_APPIMAGE_OUTPUT_PLUGIN_FILE_NAME,
                ),
                "utf8",
            ),
            pinnedPlugin,
        );
        assert.equal((await lstat(adapter)).mode & 0o777, 0o755);
        await assert.rejects(
            runRedactedCommand(adapter, ["--appdir", appDir], {
                env: { ...environment, TEST_PLUGIN_EXIT_CODE: "7" },
            }),
            /exit code 7/,
        );
        await assert.rejects(
            runRedactedCommand(adapter, [], { env: environment }),
            /requires --appdir/,
        );
    });
});

async function withAppDir(callback) {
    const temporaryRoot = await mkdtemp(
        path.join(os.tmpdir(), "artgod-host-libraries-"),
    );
    const appDir = path.join(temporaryRoot, "ArtGod test.AppDir");
    await writeFixtureFile(path.join(appDir, "AppRun"), "launcher");
    await mkdir(path.join(appDir, "usr"));
    try {
        await callback({ appDir, temporaryRoot });
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
}

async function writeFixtureFile(filePath, content) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
}
