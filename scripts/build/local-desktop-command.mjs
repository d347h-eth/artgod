import { spawn } from "node:child_process";
import path from "node:path";
import {
    LOCAL_DESKTOP_FEATURE,
    LOCAL_RUNTIME_RELATIVE_PATH,
    LOCAL_SIDECAR_DIRECTORY,
    localDesktopPaths,
    projectRoot,
} from "./local-desktop-contract.mjs";

export const yarnCommand = process.platform === "win32" ? "yarn.cmd" : "yarn";

export function localTauriConfig() {
    return {
        build: {
            beforeBuildCommand:
                "yarn node scripts/build/prepare-local-desktop.mjs",
        },
        bundle: {
            resources: [LOCAL_RUNTIME_RELATIVE_PATH],
            externalBin: [
                `${path.posix.relative("src-tauri", LOCAL_SIDECAR_DIRECTORY)}/artgod-secret-prompt`,
            ],
        },
    };
}

export function localDesktopBuildInvocation(args, environment = process.env) {
    const forwarded = [...args];
    const bundled = forwarded[0] === "--bundle";
    if (bundled) forwarded.shift();
    // Output/profile/config cannot be overridden independently of the native feature.
    for (let i = 0; i < forwarded.length; i += 1) {
        const arg = forwarded[i];
        if (["--debug", "--verbose", "-v"].includes(arg)) continue;
        if (
            ["--target", "-t", "--bundles", "-b"].includes(arg) &&
            forwarded[i + 1] &&
            !forwarded[i + 1].startsWith("-")
        ) {
            if ((arg === "--bundles" || arg === "-b") && !bundled)
                throw new Error("--bundles requires the local bundle command.");
            i += 1;
            continue;
        }
        throw new Error(
            `Unsupported local desktop argument: ${arg}. Use --debug, --target <triple>, or --bundle --bundles <formats>.`,
        );
    }
    const env = { ...environment, CARGO_TARGET_DIR: localDesktopPaths().cargo };
    // A caller's release signing environment must not turn this into the release path.
    for (const key of Object.keys(env)) {
        if (key.startsWith("APPLE_") || key.startsWith("TAURI_SIGNING_"))
            delete env[key];
    }
    delete env.TAURI_CONFIG;
    return {
        command: yarnCommand,
        args: [
            "tauri",
            "build",
            "--ci",
            ...(!bundled ? ["--no-bundle"] : []),
            "--features",
            LOCAL_DESKTOP_FEATURE,
            "--config",
            JSON.stringify(localTauriConfig()),
            ...forwarded,
        ],
        env,
    };
}

export function runLocalBuildCommand(
    command,
    args,
    { env = process.env, cwd = projectRoot } = {},
) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            env,
            stdio: "inherit",
            shell: false,
        });
        child.once("error", reject);
        child.once("exit", (code, signal) =>
            code === 0
                ? resolve()
                : reject(
                      new Error(
                          `${command} ${args.join(" ")} failed (${code ?? signal}).`,
                      ),
                  ),
        );
    });
}
