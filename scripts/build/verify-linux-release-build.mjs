import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runRedactedCommand } from "./secret-output-redaction.mjs";
import {
    TAURI_LINUX_BUNDLE_BUILD_SCRIPT_NAME,
    TAURI_LINUX_BUNDLER_TARGET,
} from "./prepare-tauri-linux-bundler-tools.mjs";
import {
    DESKTOP_BUILD_TARGET_ENV_KEYS,
    DESKTOP_NODE_DIST_TARGET,
} from "./native-runtime-dependencies.mjs";
import { DESKTOP_CARGO_PROJECTS } from "./cargo-projects.mjs";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
export const LINUX_RELEASE_BUILD_SCRIPT_NAME = "check:linux-release-build";
export const LINUX_RELEASE_BUILD_PHASE = Object.freeze({
    Prerequisites: "prerequisites",
    NoBundle: "no-bundle",
    Bundle: "bundle",
});

function yarn(label, ...args) {
    return Object.freeze({ label, command: "yarn", args: Object.freeze(args) });
}
function cargo(label, ...args) {
    return Object.freeze({
        label,
        command: "cargo",
        args: Object.freeze([
            "test",
            "--manifest-path",
            DESKTOP_CARGO_PROJECTS.Desktop.manifestPath,
            "--locked",
            ...args,
        ]),
    });
}

// Both hosted CI and isolated Ubuntu reproduction consume this ordered owner.
// Installation/provisioning and release signing remain the caller's responsibility.
export const LINUX_RELEASE_BUILD_CHECKS = Object.freeze({
    [LINUX_RELEASE_BUILD_PHASE.Prerequisites]: Object.freeze([
        yarn("Build trusted native SQLite dependency", "build:sqlite-native"),
        yarn("Test bidding strategy coverage", "test:bidding:strategy"),
        yarn(
            "Check desktop runtime registry consistency",
            "check:runtime-registry",
        ),
        yarn("Test desktop release security", "test:desktop:release"),
        yarn("Test desktop Admin manifest", "test:desktop:admin-manifest"),
        yarn(
            "Test desktop listener boundaries",
            "test:desktop:listener-boundaries",
        ),
        yarn(
            "Test sensitive process hardening",
            "test:desktop:sensitive-process",
        ),
        cargo(
            "Test Admin WebView shell ACL",
            "--test",
            "webview_capability_security",
        ),
        cargo(
            "Test Linux runtime resource layout",
            "--test",
            "linux_runtime_resource_layout",
        ),
        yarn(
            "Test desktop parent containment",
            "test:desktop:parent-containment",
        ),
    ]),
    [LINUX_RELEASE_BUILD_PHASE.NoBundle]: Object.freeze([
        cargo(
            "Test Tauri runtime output reconciliation",
            "--offline",
            "--test",
            "tauri_runtime_output_reconciliation",
        ),
        yarn(
            "Tauri no-bundle build check",
            "build:desktop:no-bundle",
            "--debug",
        ),
        yarn(
            "Verify staged desktop runtime resources",
            "check:desktop-runtime-resources",
        ),
        yarn(
            "Test desktop runtime loader isolation",
            "test:desktop:runtime-environment",
        ),
        yarn(
            "Verify no-bundle desktop runtime output",
            "check:desktop-no-bundle-runtime",
        ),
    ]),
    [LINUX_RELEASE_BUILD_PHASE.Bundle]: Object.freeze([
        yarn("Build Linux Tauri bundle", TAURI_LINUX_BUNDLE_BUILD_SCRIPT_NAME),
        yarn(
            "Verify staged desktop runtime resources",
            "check:desktop-runtime-resources",
        ),
        yarn(
            "Verify Linux bundled runtime integrity",
            "check:linux-bundled-runtime",
            `src-tauri/target/${TAURI_LINUX_BUNDLER_TARGET}/release/bundle`,
        ),
    ]),
});

export async function verifyLinuxReleaseBuild({
    phase,
    cwd = rootDir,
    environment = process.env,
    runCommand = runRedactedCommand,
    onCheck = async () => {},
} = {}) {
    if (
        phase !== undefined &&
        !Object.values(LINUX_RELEASE_BUILD_PHASE).includes(phase)
    )
        throw new Error(`Unknown Linux release build phase: ${phase}.`);
    const phases =
        phase === undefined
            ? Object.values(LINUX_RELEASE_BUILD_PHASE)
            : [phase];
    const env = {
        ...environment,
        [DESKTOP_BUILD_TARGET_ENV_KEYS.NodeDistributionTarget]:
            DESKTOP_NODE_DIST_TARGET.LinuxX64,
        [DESKTOP_BUILD_TARGET_ENV_KEYS.NatsDistributionTarget]:
            DESKTOP_NODE_DIST_TARGET.LinuxX64,
        APPIMAGE_EXTRACT_AND_RUN: "1",
    };
    for (const selectedPhase of phases) {
        for (const check of LINUX_RELEASE_BUILD_CHECKS[selectedPhase]) {
            console.log(`\n${check.label}`);
            await onCheck({
                ...check,
                phase: selectedPhase,
                status: "running",
            });
            try {
                await runCommand(check.command, check.args, {
                    cwd,
                    env,
                    stream: true,
                });
                await onCheck({
                    ...check,
                    phase: selectedPhase,
                    status: "passed",
                });
            } catch (error) {
                await onCheck({
                    ...check,
                    phase: selectedPhase,
                    status: "failed",
                });
                throw error;
            }
        }
    }
}

async function main() {
    if (process.platform !== "linux" || process.arch !== "x64")
        throw new Error(
            "Linux release verification requires a Linux x64 environment.",
        );
    let phase;
    let reportPath;
    const args = process.argv.slice(2);
    while (args.length) {
        const flag = args.shift();
        const value = args.shift();
        if (!value || !["--phase", "--report"].includes(flag))
            throw new Error(
                "Usage: verify-linux-release-build.mjs [--phase prerequisites|no-bundle|bundle] [--report path]",
            );
        if (flag === "--phase") phase = value;
        else reportPath = value;
    }
    if (!reportPath) {
        await mkdir(path.join(rootDir, "tmp"), { recursive: true });
        reportPath = path.join(
            await mkdtemp(path.join(rootDir, "tmp", "linux-release-checks-")),
            "checks.json",
        );
    }
    await mkdir(path.dirname(reportPath), { recursive: true });
    const checks = [];
    console.log(`Check report: ${reportPath}`);
    await verifyLinuxReleaseBuild({
        phase,
        onCheck: async (check) => {
            checks.push({ ...check, recordedAt: new Date().toISOString() });
            await writeFile(reportPath, `${JSON.stringify(checks, null, 2)}\n`);
        },
    });
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
    await main();
