import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
    prepareNativeDiagnostics,
    validateNativeDiagnostics,
    nativeCoreLimitCommand,
    assertNativeCoreLimits,
    NATIVE_CORE_POLICY,
    NATIVE_DIAGNOSTIC_PROFILE,
} from "./native-failure-evidence.mjs";
import { RUNTIME_PROCESS } from "./runtime-manifest.mjs";

const settings = { profile: NATIVE_DIAGNOSTIC_PROFILE.BoundedCore };
const limits = `Max core file size        ${NATIVE_CORE_POLICY.bytes}             ${NATIVE_CORE_POLICY.bytes}             bytes\n`;
const spec = {
    id: RUNTIME_PROCESS.Domain,
    filename: "/workbench/runtime/indexer/dist-desktop/domain-worker.mjs",
};
function fixture(options = {}) {
    const files = new Map([
        ["/proc/sys/kernel/core_pattern", Buffer.from("core\n")],
        ["/proc/self/coredump_filter", Buffer.from("00000033\n")],
        [NATIVE_CORE_POLICY.executable, Buffer.from("fixture prlimit bytes")],
        ["/proc/123/limits", Buffer.from(options.wrongLimits ?? limits)],
        ["/proc/123/coredump_filter", Buffer.from("00000010\n")],
        [
            "/proc/123/cmdline",
            Buffer.from(`${process.execPath}\0${spec.filename}\0`),
        ],
    ]);
    const operations = [];
    const directory = "/workbench/output/native-core";
    for (const [name, bytes] of Object.entries(options.cores ?? {}))
        files.set(`${directory}/${name}`, bytes);
    const io = {
        async readlink(filename) {
            operations.push(["readlink", filename]);
            return filename === "/proc/1/exe"
                ? options.host
                    ? "/usr/lib/systemd/systemd"
                    : "/usr/bin/busybox"
                : process.execPath;
        },
        async realpath(filename) {
            assert.equal(filename, "/bin/busybox");
            return "/usr/bin/busybox";
        },
        async lstat(filename) {
            operations.push(["lstat", filename]);
            const bytes = files.get(filename);
            if (!bytes) throw new Error("Missing fixture file");
            return {
                isFile: () => !options.symlink,
                size:
                    filename === NATIVE_CORE_POLICY.executable
                        ? bytes.length
                        : (options.coreSize ?? bytes.length),
            };
        },
        async readFile(filename, encoding) {
            operations.push(["readFile", filename]);
            const bytes = files.get(filename);
            if (!bytes) throw new Error(`Missing ${filename}`);
            return encoding ? bytes.toString() : bytes;
        },
        async writeFile(filename, value) {
            operations.push(["writeFile", filename]);
            const text =
                filename === "/proc/self/coredump_filter"
                    ? options.wrongFilter
                        ? "00000033\n"
                        : "00000010\n"
                    : value;
            files.set(filename, Buffer.from(text));
        },
        async mkdir(filename) {
            operations.push(["mkdir", filename]);
        },
        async readdir() {
            return [...files.keys()]
                .filter((name) => name.startsWith(`${directory}/`))
                .map((name) => name.slice(directory.length + 1));
        },
    };
    const prepare = () =>
        prepareNativeDiagnostics({
            settings,
            root: "/workbench",
            output: "/workbench/output",
            io,
        });
    return { io, files, operations, prepare };
}

test("capture policy refuses host execution and unsupported profiles before any write", async () => {
    const f = fixture({ host: true });
    await assert.rejects(f.prepare(), /private replay guest/);
    assert.ok(
        !f.operations.some(([operation]) =>
            ["writeFile", "mkdir"].includes(operation),
        ),
    );
    assert.throws(
        () => validateNativeDiagnostics({ ...settings, coreBytes: 0 }),
        /exactly/,
    );
    assert.throws(
        () => validateNativeDiagnostics({ profile: "unbounded" }),
        /exactly/,
    );
    assert.deepEqual(
        nativeCoreLimitCommand(process.execPath, [spec.filename]),
        {
            file: "/usr/bin/prlimit",
            args: [
                "--core=33554432:33554432",
                "--",
                process.execPath,
                spec.filename,
            ],
        },
    );
});

test("effective byte limits, filter and unchanged real Node argv are required for the single selected generation", async () => {
    const f = fixture(),
        diagnostics = await f.prepare();
    const legacy = { ...spec, id: RUNTIME_PROCESS.Sync };
    assert.deepEqual(
        diagnostics.launchCommand(legacy, process.execPath, [legacy.filename]),
        { file: process.execPath, args: [legacy.filename] },
    );
    assert.deepEqual(
        diagnostics.launchCommand(
            { ...spec, generation: 1 },
            process.execPath,
            [spec.filename],
        ),
        { file: process.execPath, args: [spec.filename] },
    );
    assert.equal(
        diagnostics.launchCommand(spec, process.execPath, [spec.filename]).file,
        NATIVE_CORE_POLICY.executable,
    );
    const child = { pid: 123, exitCode: null, signalCode: null };
    diagnostics.track(spec, child);
    await diagnostics.verifyRuntime(spec, child);
    const receipt = await diagnostics.capture();
    assert.equal(
        receipt.effective.actor.coreSoftBytes,
        NATIVE_CORE_POLICY.bytes,
    );
    assert.equal(
        receipt.effective.actor.coreHardBytes,
        NATIVE_CORE_POLICY.bytes,
    );
    assert.deepEqual(receipt.effective.actor.argv, [
        process.execPath,
        spec.filename,
    ]);
    assert.equal(receipt.coreExpected, false);
    assert.equal(receipt.missing, false);
    assert.throws(
        () =>
            diagnostics.launchCommand(spec, process.execPath, [spec.filename]),
        /one actor generation/,
    );
    assert.throws(
        () =>
            assertNativeCoreLimits(
                limits.replace(String(NATIVE_CORE_POLICY.bytes), "0"),
                "00000010",
            ),
        /exact bounded/,
    );
    await assert.rejects(fixture({ wrongFilter: true }).prepare(), /read-back/);
});

test("missing, malformed, foreign, symbolic and oversized cores remain explicit bounded evidence", async () => {
    const badCore = Buffer.alloc(64);
    for (const options of [
        {},
        { cores: { "core.123.11": badCore } },
        { cores: { "core.999.11": badCore } },
        { cores: { "core.123.11": badCore }, symlink: true },
        {
            cores: { "core.123.11": badCore },
            coreSize: NATIVE_CORE_POLICY.bytes + 1,
        },
        { cores: { "core.123.11": badCore, "core.123.6": badCore } },
    ]) {
        const f = fixture(options);
        // The tool remains a valid regular file when only the core is a symlink.
        if (options.symlink) {
            const stat = f.io.lstat;
            f.io.lstat = async (filename) =>
                filename === NATIVE_CORE_POLICY.executable
                    ? {
                          isFile: () => true,
                          size: f.files.get(NATIVE_CORE_POLICY.executable)
                              .length,
                      }
                    : stat(filename);
        }
        const diagnostics = await f.prepare();
        diagnostics.track(spec, {
            pid: 123,
            exitCode: null,
            signalCode: "SIGSEGV",
        });
        const receipt = await diagnostics.capture();
        assert.equal(receipt.coreExpected, true);
        if (!options.cores) assert.equal(receipt.missing, true);
        else if (
            Object.keys(options.cores).length === 1 &&
            !options.symlink &&
            !options.coreSize &&
            options.cores["core.123.11"]
        ) {
            assert.equal(receipt.cores[0].notesComplete, false);
            assert.match(receipt.cores[0].error, /ELF64/);
            assert.equal(
                receipt.cores[0].sha256,
                createHash("sha256").update(badCore).digest("hex"),
            );
        } else assert.ok(receipt.error);
        if (options.coreSize || options.symlink)
            assert.ok(
                !f.operations.some(
                    ([operation, filename]) =>
                        operation === "readFile" &&
                        filename.startsWith("/workbench/output/native-core/"),
                ),
            );
    }
});
