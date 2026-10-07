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
export const TAURI_OPERATION = Object.freeze({ Build: "build", Dev: "dev" });
const tauriCliEntrypointRequest = `${TAURI_CLI_PACKAGE_NAME}/tauri.js`;

// Existing Linux packaging consumers share the same build/development owner.
export async function buildLockedTauri(args, options) {
    return await runLockedTauri(TAURI_OPERATION.Build, args, options);
}

// Tauri development has three argument segments: CLI, Cargo runner, application.
// Lock enforcement belongs only to Cargo, before the application separator.
export async function runLockedTauri(
    operation,
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
    if (!Object.values(TAURI_OPERATION).includes(operation)) {
        throw new Error(`Unsupported locked Tauri operation: ${operation}.`);
    }
    const separator = args.indexOf("--");
    const tauriArgs = separator === -1 ? args : args.slice(0, separator);
    const runnerArgs = separator === -1 ? [] : args.slice(separator + 1);
    const applicationSeparator =
        operation === TAURI_OPERATION.Dev ? runnerArgs.indexOf("--") : -1;
    const cargoArgs =
        applicationSeparator === -1
            ? runnerArgs
            : runnerArgs.slice(0, applicationSeparator);
    const applicationArgs =
        applicationSeparator === -1
            ? []
            : runnerArgs.slice(applicationSeparator);
    // Windows cannot spawn Yarn's .cmd shim without a shell. Standard module
    // resolution under the project Yarn install selects the pinned Tauri CLI.
    const commandPrefix =
        platform === "win32" ? [resolveCliEntrypoint()] : ["tauri"];
    return await runCommand(
        platform === "win32" ? process.execPath : "yarn",
        [
            ...commandPrefix,
            operation,
            ...tauriArgs,
            "--",
            ...cargoArgs,
            ...(cargoArgs.includes("--locked") ? [] : ["--locked"]),
            ...applicationArgs,
        ],
        { cwd, env: environment, stream: true },
    );
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
    const args = process.argv.slice(2);
    const operation = Object.values(TAURI_OPERATION).includes(args[0])
        ? args.shift()
        : TAURI_OPERATION.Build;
    if (
        process.platform === "linux" &&
        operation === TAURI_OPERATION.Build &&
        !args.includes("--no-bundle") &&
        !args.includes("--help")
    ) {
        throw new Error(
            `Linux bundles require yarn ${TAURI_BUILD_SCRIPT_NAMES.LinuxBundle}.`,
        );
    }
    await runLockedTauri(operation, args);
}
