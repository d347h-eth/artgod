import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
    LINUX_RELEASE_BUILD_CHECKS,
    LINUX_RELEASE_BUILD_PHASE,
    resolveLinuxReleaseOutputDirectories,
    verifyLinuxReleaseBuild,
} from "./verify-linux-release-build.mjs";
import {
    DESKTOP_BUILD_TARGET_ENV_KEYS,
    DESKTOP_NODE_DIST_TARGET,
} from "./native-runtime-dependencies.mjs";
import { TAURI_LINUX_BUNDLER_TARGET } from "./prepare-tauri-linux-bundler-tools.mjs";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const targetDirectory = path.resolve("fixture custom Cargo output");
const outputDirectories = {
    noBundleRuntimeDirectory: path.join(
        targetDirectory,
        TAURI_LINUX_BUNDLER_TARGET,
        "debug",
        "resources",
        "runtime",
    ),
    bundleDirectory: path.join(
        targetDirectory,
        TAURI_LINUX_BUNDLER_TARGET,
        "release",
        "bundle",
    ),
};

test("the common lane preserves prerequisite, no-bundle and final-package order", async () => {
    const calls = [];
    const progress = [];
    await verifyLinuxReleaseBuild({
        cwd: "/fixture/checkout",
        environment: { KEPT: "present" },
        async runCommand(command, args, options) {
            assert.equal(
                options.env.CARGO_BUILD_TARGET,
                TAURI_LINUX_BUNDLER_TARGET,
            );
            if (command === "cargo" && args[0] === "metadata") {
                assert.equal(
                    options.cwd,
                    path.join("/fixture/checkout", "src-tauri"),
                );
                return {
                    stdout: JSON.stringify({
                        target_directory: targetDirectory,
                    }),
                };
            }
            calls.push({ command, args });
            assert.equal(options.cwd, "/fixture/checkout");
            assert.equal(options.env.KEPT, "present");
            assert.equal(
                options.env[
                    DESKTOP_BUILD_TARGET_ENV_KEYS.NodeDistributionTarget
                ],
                DESKTOP_NODE_DIST_TARGET.LinuxX64,
            );
            assert.equal(
                options.env[
                    DESKTOP_BUILD_TARGET_ENV_KEYS.NatsDistributionTarget
                ],
                DESKTOP_NODE_DIST_TARGET.LinuxX64,
            );
            assert.equal(options.env.APPIMAGE_EXTRACT_AND_RUN, "1");
        },
        async onCheck(check) {
            progress.push(check);
        },
    });
    const expected = Object.values(LINUX_RELEASE_BUILD_CHECKS).flat();
    assert.deepEqual(
        calls,
        expected.map(({ command, args, outputDirectory }) => ({
            command,
            args: outputDirectory
                ? [...args, outputDirectory(outputDirectories)]
                : args,
        })),
    );
    assert.equal(progress.length, calls.length * 2);
    assert.deepEqual(
        calls.find(({ args }) => args[0] === "build:desktop:no-bundle").args,
        [
            "build:desktop:no-bundle",
            "--debug",
            "--target",
            TAURI_LINUX_BUNDLER_TARGET,
        ],
    );
    assert.deepEqual(
        [...new Set(progress.map((check) => check.phase))],
        Object.values(LINUX_RELEASE_BUILD_PHASE),
    );
    for (const check of expected.filter((check) => check.command === "cargo"))
        assert.ok(check.args.includes("--locked"));
    const bundleChecks =
        LINUX_RELEASE_BUILD_CHECKS[LINUX_RELEASE_BUILD_PHASE.Bundle];
    assert.deepEqual(
        bundleChecks.map((check) => check.args[0]),
        [
            "build:desktop:linux-bundle",
            "check:desktop-runtime-resources",
            "check:linux-bundled-runtime",
        ],
    );
});

test("a failing gate stops later compilation and remains visible in the report", async () => {
    const events = [];
    let calls = 0;
    await assert.rejects(
        verifyLinuxReleaseBuild({
            phase: LINUX_RELEASE_BUILD_PHASE.Prerequisites,
            async runCommand() {
                if (++calls === 2) throw new Error("fixture gate failed");
            },
            async onCheck(check) {
                events.push(check.status);
            },
        }),
        /fixture gate failed/,
    );
    assert.equal(calls, 2);
    assert.deepEqual(events, ["running", "passed", "running", "failed"]);
});

test("CI phase selection excludes other phases and rejects unknown phases", async () => {
    const calls = [];
    await verifyLinuxReleaseBuild({
        phase: LINUX_RELEASE_BUILD_PHASE.Bundle,
        async runCommand(command, args) {
            if (command === "cargo" && args[0] === "metadata")
                return {
                    stdout: JSON.stringify({
                        target_directory: targetDirectory,
                    }),
                };
            calls.push({ command, args });
        },
    });
    assert.equal(
        calls.length,
        LINUX_RELEASE_BUILD_CHECKS[LINUX_RELEASE_BUILD_PHASE.Bundle].length,
    );
    await assert.rejects(
        verifyLinuxReleaseBuild({
            phase: "unknown",
            async runCommand() {
                assert.fail("Unknown phase cannot dispatch.");
            },
        }),
        /Unknown Linux release build phase/,
    );
});

test("runtime verification follows real Cargo target-dir configuration and environment overrides", async () => {
    await mkdir(path.join(rootDir, "tmp"), { recursive: true });
    const projectRoot = await mkdtemp(
        path.join(rootDir, "tmp", "linux-output-target-"),
    );
    const crate = path.join(projectRoot, "src-tauri");
    await mkdir(path.join(crate, "src"), { recursive: true });
    await mkdir(path.join(crate, ".cargo"));
    await writeFile(
        path.join(crate, "Cargo.toml"),
        '[package]\nname = "output-fixture"\nversion = "0.1.0"\nedition = "2021"\n',
    );
    await writeFile(
        path.join(crate, "Cargo.lock"),
        'version = 4\n\n[[package]]\nname = "output-fixture"\nversion = "0.1.0"\n',
    );
    await writeFile(path.join(crate, "src/main.rs"), "fn main() {}\n");
    const configured = path.join(projectRoot, "configured target with spaces");
    await writeFile(
        path.join(crate, ".cargo/config.toml"),
        `[build]\ntarget-dir = ${JSON.stringify(configured)}\n`,
    );
    const environment = { ...process.env, CARGO_NET_OFFLINE: "true" };
    delete environment.CARGO_TARGET_DIR;
    const fromConfig = await resolveLinuxReleaseOutputDirectories({
        projectRoot,
        environment,
    });
    assert.equal(fromConfig.targetDirectory, configured);
    assert.equal(
        fromConfig.noBundleRuntimeDirectory,
        path.join(
            configured,
            TAURI_LINUX_BUNDLER_TARGET,
            "debug",
            "resources",
            "runtime",
        ),
    );
    const overridden = path.join(projectRoot, "environment target with spaces");
    const fromEnvironment = await resolveLinuxReleaseOutputDirectories({
        projectRoot,
        environment: { ...environment, CARGO_TARGET_DIR: overridden },
    });
    assert.equal(fromEnvironment.targetDirectory, overridden);
    assert.equal(
        fromEnvironment.bundleDirectory,
        path.join(overridden, TAURI_LINUX_BUNDLER_TARGET, "release", "bundle"),
    );
    assert.notEqual(
        fromEnvironment.bundleDirectory,
        path.join(
            crate,
            "target",
            TAURI_LINUX_BUNDLER_TARGET,
            "release",
            "bundle",
        ),
    );
});
