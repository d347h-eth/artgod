import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runRedactedCommand } from "./secret-output-redaction.mjs";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const moduleRequire = createRequire(import.meta.url);
export const TAURI_BUILD_SCRIPT_NAMES = Object.freeze({
    NoBundle: "build:desktop:no-bundle",
    LinuxBundle: "build:desktop:linux-bundle",
});
export const TAURI_CLI_PACKAGE_NAME = "@tauri-apps/cli";
const tauriCliEntrypointRequest = `${TAURI_CLI_PACKAGE_NAME}/tauri.js`;

// Keep caller Tauri flags before its Cargo separator; append lock enforcement
// after caller Cargo flags so aliases such as no-bundle --debug keep working.
export async function buildLockedTauri(
    args,
    {
        environment = process.env,
        runCommand = runRedactedCommand,
        cwd = rootDir,
        platform = process.platform,
        resolveCliEntrypoint = () =>
            moduleRequire.resolve(tauriCliEntrypointRequest),
    } = {},
) {
    const separator = args.indexOf("--");
    const tauriArgs = separator === -1 ? args : args.slice(0, separator);
    const cargoArgs = separator === -1 ? [] : args.slice(separator + 1);
    // Windows cannot spawn Yarn's .cmd shim without a shell. Standard module
    // resolution under the project Yarn install selects the pinned Tauri CLI.
    const commandPrefix =
        platform === "win32" ? [resolveCliEntrypoint()] : ["tauri"];
    await runCommand(
        platform === "win32" ? process.execPath : "yarn",
        [
            ...commandPrefix,
            "build",
            ...tauriArgs,
            "--",
            ...cargoArgs,
            ...(cargoArgs.includes("--locked") ? [] : ["--locked"]),
        ],
        { cwd, env: environment, stream: true },
    );
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
    if (
        process.platform === "linux" &&
        !process.argv.slice(2).includes("--no-bundle")
    ) {
        throw new Error(
            `Linux bundles require yarn ${TAURI_BUILD_SCRIPT_NAMES.LinuxBundle}.`,
        );
    }
    await buildLockedTauri(process.argv.slice(2));
}
