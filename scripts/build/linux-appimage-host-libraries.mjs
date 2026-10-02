import { lstat, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);

// Mesa/EGL comes from the host and must use that host's Wayland ABI. An older
// client in AppRun's LD_LIBRARY_PATH can prevent even X11 WebViews from starting.
function isHostWaylandLibrary(fileName) {
    return /^libwayland-(client|server|cursor|egl)\.so(?:\..+)?$/.test(
        fileName,
    );
}

// Do not follow links: usr/lib64 may alias usr/lib, or point outside the AppDir.
async function collectHostWaylandLibraries(appDir) {
    if (!(await lstat(appDir)).isDirectory()) {
        throw new Error("AppImage library policy requires a directory.");
    }
    const libraries = [];
    async function visit(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                await visit(entryPath);
            } else if (isHostWaylandLibrary(entry.name)) {
                libraries.push(path.relative(appDir, entryPath));
            }
        }
    }
    await visit(appDir);
    return libraries.sort();
}

// Run after all input plugins, immediately before the pinned output plugin.
// This also catches dependencies reintroduced by a plugin's linuxdeploy call.
export async function omitAppImageHostLibraries(appDir) {
    const [launcher, usrDirectory] = await Promise.all([
        lstat(path.join(appDir, "AppRun")),
        lstat(path.join(appDir, "usr")),
    ]);
    if (
        !(launcher.isFile() || launcher.isSymbolicLink()) ||
        !usrDirectory.isDirectory()
    ) {
        throw new Error(
            "AppImage library policy requires an AppDir with AppRun and usr.",
        );
    }
    const libraries = await collectHostWaylandLibraries(appDir);
    for (const relativePath of libraries) {
        await unlink(path.join(appDir, relativePath));
    }
    await verifyAppImageHostLibraries(appDir);
    return libraries;
}

export async function verifyAppImageHostLibraries(appDir) {
    const libraries = await collectHostWaylandLibraries(appDir);
    if (libraries.length > 0) {
        throw new Error(
            `AppImage must use host Wayland libraries; bundled copies found: ${libraries.join(", ")}.`,
        );
    }
}

async function main() {
    const args = process.argv.slice(2);
    // linuxdeploy probes the original plugin before passing its AppDir. Let the
    // wrapper forward these probes without modifying any packaging input.
    if (
        args.length === 1 &&
        ["--plugin-api-version", "--plugin-type"].includes(args[0])
    ) {
        return;
    }
    let appDir;
    if (args.length === 2 && args[0] === "--appdir" && args[1]) {
        appDir = args[1];
    } else if (args.length === 1 && args[0].startsWith("--appdir=")) {
        appDir = args[0].slice("--appdir=".length);
    }
    if (!appDir) {
        throw new Error("AppImage output plugin requires --appdir <AppDir>.");
    }
    const omitted = await omitAppImageHostLibraries(path.resolve(appDir));
    for (const library of omitted) {
        console.log(`Using host library instead of AppImage copy: ${library}`);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    await main();
}
