import assert from "node:assert/strict";
import test from "node:test";
import {
    LINUX_RELEASE_BUILD_CHECKS,
    LINUX_RELEASE_BUILD_PHASE,
    verifyLinuxReleaseBuild,
} from "./verify-linux-release-build.mjs";
import {
    DESKTOP_BUILD_TARGET_ENV_KEYS,
    DESKTOP_NODE_DIST_TARGET,
} from "./native-runtime-dependencies.mjs";

test("the common lane preserves prerequisite, no-bundle and final-package order", async () => {
    const calls = [];
    const progress = [];
    await verifyLinuxReleaseBuild({
        cwd: "/fixture/checkout",
        environment: { KEPT: "present" },
        async runCommand(command, args, options) {
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
        expected.map(({ command, args }) => ({ command, args })),
    );
    assert.equal(progress.length, calls.length * 2);
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
