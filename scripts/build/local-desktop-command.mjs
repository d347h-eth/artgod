import path from "node:path";
import { readFileSync } from "node:fs";
import {
    buildLockedTauri,
    runLockedTauri,
    TAURI_OPERATION,
} from "./build-tauri.mjs";
import { prepareLocalDesktop } from "./prepare-local-desktop.mjs";
import {
    preparePinnedTauriLinuxBundlerTools,
    resolveTauriLocalToolsDirectory,
    resolveTauriToolsCacheDirectory,
    stageTauriLinuxBundleTools,
    TAURI_LINUX_APPIMAGE_RUNTIME_ENV_KEY,
    TAURI_LINUX_APPIMAGE_RUNTIME_FILE_NAME,
} from "./prepare-tauri-linux-bundler-tools.mjs";
import {
    LOCAL_DESKTOP_FEATURE,
    LOCAL_RUNTIME_RELATIVE_PATH,
    LOCAL_SIDECAR_DIRECTORY,
    LOCAL_LINUX_RUNTIME_PATHS,
    localDesktopPaths,
} from "./local-desktop-contract.mjs";

export function localTauriConfig(platform = process.platform) {
    // Tauri applies its platform config before this overlay. Remove inherited
    // production file mappings through JSON Merge Patch and select local files.
    const productionLinuxConfig = JSON.parse(
        readFileSync(
            new URL("../../src-tauri/tauri.linux.conf.json", import.meta.url),
            "utf8",
        ),
    );
    return {
        build: {
            beforeBuildCommand:
                "yarn node scripts/build/prepare-local-desktop.mjs",
        },
        bundle: {
            resources:
                platform === "linux" ? [] : [LOCAL_RUNTIME_RELATIVE_PATH],
            externalBin: [
                `${path.posix.relative("src-tauri", LOCAL_SIDECAR_DIRECTORY)}/artgod-secret-prompt`,
            ],
            ...(platform === "linux"
                ? {
                      linux: Object.fromEntries(
                          Object.entries(LOCAL_LINUX_RUNTIME_PATHS).map(
                              ([format, destination]) => [
                                  format,
                                  {
                                      files: {
                                          ...Object.fromEntries(
                                              Object.keys(
                                                  productionLinuxConfig.bundle
                                                      .linux[format].files,
                                              ).map((key) => [key, null]),
                                          ),
                                          [destination]:
                                              LOCAL_RUNTIME_RELATIVE_PATH,
                                      },
                                  },
                              ],
                          ),
                      ),
                  }
                : {}),
        },
    };
}

export function localDesktopBuildInvocation(
    args,
    environment = process.env,
    platform = process.platform,
) {
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
    return {
        args: [
            "--ci",
            ...(!bundled ? ["--no-bundle"] : []),
            "--features",
            LOCAL_DESKTOP_FEATURE,
            "--config",
            JSON.stringify(localTauriConfig(platform)),
            ...forwarded,
        ],
        env: localDesktopEnvironment(environment),
    };
}

function localDesktopEnvironment(environment) {
    const env = { ...environment, CARGO_TARGET_DIR: localDesktopPaths().cargo };
    // A caller's release signing environment must not turn this into the release path.
    for (const key of Object.keys(env)) {
        if (key.startsWith("APPLE_") || key.startsWith("TAURI_SIGNING_"))
            delete env[key];
    }
    delete env.TAURI_CONFIG;
    return env;
}

// The managed Admin server supplies frontend reload; native resources stay local.
export function localDesktopDevInvocation(
    args,
    environment = process.env,
    platform = process.platform,
) {
    for (const arg of args) {
        if (!["--verbose", "-v", "--help", "-h"].includes(arg))
            throw new Error(
                `Unsupported local desktop dev argument: ${arg}. Use --verbose or --help.`,
            );
    }
    const config = localTauriConfig(platform);
    config.build.beforeDevCommand =
        "node ./scripts/build/dev-frontend-target.mjs admin";
    return {
        args: [
            "--no-watch",
            "--features",
            LOCAL_DESKTOP_FEATURE,
            "--config",
            JSON.stringify(config),
            ...args,
        ],
        env: localDesktopEnvironment(environment),
    };
}

export async function devLocalDesktop(
    args,
    {
        environment = process.env,
        platform = process.platform,
        prepare = prepareLocalDesktop,
        runTauri = runLockedTauri,
    } = {},
) {
    const invocation = localDesktopDevInvocation(args, environment, platform);
    if (!args.some((arg) => ["--help", "-h"].includes(arg)))
        await prepare({ development: true, environment: invocation.env });
    return runTauri(TAURI_OPERATION.Dev, invocation.args, {
        environment: invocation.env,
    });
}

// Shared tool owners enforce locks/input admission; local selection stays here.
export async function buildLocalDesktop(
    args,
    {
        environment = process.env,
        platform = process.platform,
        buildTauri = buildLockedTauri,
        prepareLinuxTools = preparePinnedTauriLinuxBundlerTools,
        resolveLinuxTools = resolveTauriLocalToolsDirectory,
        stageLinuxTools = stageTauriLinuxBundleTools,
    } = {},
) {
    const invocation = localDesktopBuildInvocation(args, environment, platform);
    const bundlesIndex = invocation.args.findIndex((arg) =>
        ["--bundles", "-b"].includes(arg),
    );
    const bundles =
        bundlesIndex === -1
            ? ["appimage"]
            : invocation.args[bundlesIndex + 1].split(",");
    if (
        platform === "linux" &&
        args[0] === "--bundle" &&
        (bundles.includes("appimage") || bundles.includes("all"))
    ) {
        const cacheDirectory = resolveTauriToolsCacheDirectory(invocation.env);
        await prepareLinuxTools({ cacheDirectory });
        const localToolsDirectory = await resolveLinuxTools({
            environment: invocation.env,
        });
        await stageLinuxTools({ cacheDirectory, localToolsDirectory });
        invocation.env[TAURI_LINUX_APPIMAGE_RUNTIME_ENV_KEY] = path.join(
            localToolsDirectory,
            TAURI_LINUX_APPIMAGE_RUNTIME_FILE_NAME,
        );
        const configIndex = invocation.args.indexOf("--config") + 1;
        const config = JSON.parse(invocation.args[configIndex]);
        config.bundle.useLocalToolsDir = true;
        invocation.args[configIndex] = JSON.stringify(config);
    }
    return buildTauri(invocation.args, { environment: invocation.env });
}
