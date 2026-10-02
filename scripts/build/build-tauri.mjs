import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runRedactedCommand } from "./secret-output-redaction.mjs";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
export const TAURI_BUILD_SCRIPT_NAMES = Object.freeze({
    NoBundle: "build:desktop:no-bundle",
    LinuxBundle: "build:desktop:linux-bundle",
});

// Keep caller Tauri flags before its Cargo separator; append lock enforcement
// after caller Cargo flags so aliases such as no-bundle --debug keep working.
export async function buildLockedTauri(
    args,
    {
        environment = process.env,
        runCommand = runRedactedCommand,
        cwd = rootDir,
    } = {},
) {
    const separator = args.indexOf("--");
    const tauriArgs = separator === -1 ? args : args.slice(0, separator);
    const cargoArgs = separator === -1 ? [] : args.slice(separator + 1);
    await runCommand(
        "yarn",
        [
            "tauri",
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
