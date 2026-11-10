import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import {
    captureGuestNativeFailure,
    NATIVE_FAILURE_POLICY as POLICY,
} from "./native-failure-evidence.mjs";

const procResult = "synthetic read-only proc evidence\n";
function command(runKernel, inspect = () => {}) {
    return (file, args, options, callback) => {
        // Deliberate Linux/BusyBox wire assertions: no shell or clearing flags.
        assert.equal(file, "/bin/busybox");
        assert.equal(options.timeout, POLICY.timeoutMs);
        assert.equal(options.killSignal, "SIGKILL");
        inspect(args, options);
        if (args[0] === "dmesg") return runKernel(options, callback);
        assert.equal(args[0], "cat");
        callback(null, procResult, "");
    };
}

test("native failure evidence reads the bounded kernel tail and coordinator limits without changing core policy", async () => {
    const calls = [];
    const evidence = await captureGuestNativeFailure({
        executeFile: command(
            (_options, callback) => callback(null, "node fault IP\n", ""),
            (args, options) => calls.push({ args, options }),
        ),
    });
    assert.deepEqual(
        calls.map((call) => call.args),
        [
            ["dmesg", "-s", String(POLICY.kernelBytes)],
            ["cat", "/proc/sys/kernel/core_pattern"],
            ["cat", "/proc/sys/kernel/core_uses_pid"],
            ["cat", `/proc/${process.pid}/limits`],
        ],
    );
    assert.equal(calls[0].options.maxBuffer, POLICY.kernelBytes);
    assert.equal(calls[1].options.maxBuffer, POLICY.procBytes);
    assert.equal(evidence.kernelRing.stdout, "node fault IP\n");
    assert.equal(evidence.kernelRing.code, 0);
    assert.equal(evidence.resourceLimits.pid, process.pid);
    assert.equal(evidence.resourceLimits.stdout, procResult);
});

test("missing tools and denied kernel reads remain bounded diagnostic outcomes", async () => {
    for (const code of ["ENOENT", "EPERM"]) {
        const evidence = await captureGuestNativeFailure({
            executeFile: command((_options, callback) =>
                callback(
                    Object.assign(new Error("unavailable"), { code }),
                    "",
                    "denied",
                ),
            ),
        });
        assert.equal(evidence.kernelRing.error.code, code);
        assert.equal(evidence.kernelRing.code, null);
        assert.equal(evidence.kernelRing.timedOut, false);
        assert.equal(evidence.corePattern.stdout, procResult);
    }
});

test("an actual excessive child output is terminated and cannot exceed retained evidence bounds", async () => {
    const evidence = await captureGuestNativeFailure({
        executeFile: command((options, callback) =>
            execFile(
                "/bin/sh",
                [
                    "-c",
                    "while :; do printf 'bounded diagnostic fixture output\\n'; done",
                ],
                options,
                callback,
            ),
        ),
    });
    assert.equal(evidence.kernelRing.outputLimit, true);
    assert.equal(evidence.kernelRing.timedOut, false);
    assert.ok(
        Buffer.byteLength(evidence.kernelRing.stdout) <= POLICY.kernelBytes,
    );
});

test("an actual hung diagnostic child is killed within its finite deadline", async () => {
    const started = Date.now();
    const evidence = await captureGuestNativeFailure({
        executeFile: command((options, callback) =>
            execFile("/bin/cat", [], options, callback),
        ),
    });
    assert.equal(evidence.kernelRing.timedOut, true);
    assert.equal(evidence.kernelRing.signal, "SIGKILL");
    assert.ok(Date.now() - started < POLICY.timeoutMs * 4);
});

test("adapter throws and oversized multibyte text cannot escape the failure evidence boundary", async () => {
    const thrown = await captureGuestNativeFailure({
        executeFile() {
            throw new Error("adapter unavailable");
        },
    });
    assert.equal(thrown.kernelRing.error.message, "adapter unavailable");
    const large = await captureGuestNativeFailure({
        executeFile: (_file, _args, options, callback) =>
            callback(
                Object.assign(new Error("e".repeat(POLICY.errorBytes * 2)), {
                    code: "EPERM",
                }),
                "😀".repeat(options.maxBuffer),
                "⚠".repeat(options.maxBuffer),
            ),
    });
    for (const result of [
        large.kernelRing,
        large.corePattern,
        large.coreUsesPid,
        large.resourceLimits,
    ]) {
        const limit =
            result === large.kernelRing ? POLICY.kernelBytes : POLICY.procBytes;
        assert.equal(result.outputLimit, true);
        assert.ok(Buffer.byteLength(result.stdout) <= limit);
        assert.ok(Buffer.byteLength(result.stderr) <= limit);
        assert.ok(Buffer.byteLength(result.error.message) <= POLICY.errorBytes);
    }
});
