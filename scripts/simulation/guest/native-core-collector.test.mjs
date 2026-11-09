import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
    collectNativeCore,
    prepareRegisteredNativeDiagnostics,
    validateNativeRegistry,
    assertNativeCollectorLimits,
    runNativeCoreCollector,
} from "./native-core-collector.mjs";
import {
    NATIVE_CORE_CONTEXT_POLICY as POLICY,
    NATIVE_CORE_POLICY as CORE,
    NATIVE_DIAGNOSTIC_PROFILE as PROFILE,
    NATIVE_DIAGNOSTIC_ACTOR,
} from "./native-failure-evidence.mjs";
import { nativeCoreWireFixture } from "./fixtures/native-core-wire.mjs";
import { resolveRuntimeLayout } from "./runtime-manifest.mjs";

const directory = "/workbench/output/native-core";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fixtureIo(fixture = nativeCoreWireFixture()) {
    const registry = {
        version: 1,
        coordinatorPid: 99,
        probe: true,
        actors: [
            {
                id: NATIVE_DIAGNOSTIC_ACTOR.Probe,
                generation: 0,
                pid: fixture.pid,
                filename: fixture.filename,
            },
        ],
    };
    const files = new Map([
        [
            `${directory}/${POLICY.registry}`,
            Buffer.from(JSON.stringify(registry)),
        ],
        [
            "/proc/self/limits",
            Buffer.from(
                "Max core file size         1                    1                    bytes\n",
            ),
        ],
        [`/proc/${fixture.pid}/maps`, Buffer.from(fixture.maps)],
    ]);
    const error = (code) => Object.assign(new Error(code), { code });
    const get = (name) => {
        if (!files.has(name)) throw error("ENOENT");
        return files.get(name);
    };
    const io = {
        realpath: async (filename) => {
            assert.equal(filename, "/bin/busybox");
            return "/usr/bin/busybox";
        },
        readlink: async (filename) =>
            filename === "/proc/1/exe"
                ? "/usr/bin/busybox"
                : filename === `/proc/${fixture.pid}/exe`
                  ? fixture.filename
                  : process.execPath,
        lstat: async (name) => ({ isFile: () => true, size: get(name).length }),
        readFile: async (name, encoding) =>
            encoding ? get(name).toString(encoding) : Buffer.from(get(name)),
        writeFile: async (name, bytes, options) => {
            if (options?.flag === "wx" && files.has(name))
                throw error("EEXIST");
            files.set(name, Buffer.from(bytes));
        },
        open: async (name, flags) => {
            if (flags === "wx") {
                if (files.has(name)) throw error("EEXIST");
                files.set(name, Buffer.alloc(0));
                return {
                    write: async (bytes, offset, length) => {
                        const size = Math.min(31, length);
                        files.set(
                            name,
                            Buffer.concat([
                                get(name),
                                bytes.subarray(offset, offset + size),
                            ]),
                        );
                        return { bytesWritten: size };
                    },
                    close: async () => {},
                };
            }
            return {
                read: async ({ buffer, offset, length, position }) => {
                    assert.equal(typeof position, "bigint");
                    let bytes;
                    if (name === `/proc/${fixture.pid}/mem`) {
                        const base =
                            position < 0x70000000n ? 0x400000n : 0x70000000n;
                        const source =
                            base === 0x400000n ? fixture.code : fixture.stack;
                        const at = Number(position - base);
                        bytes = source.subarray(
                            at,
                            at + Math.min(length, 4093),
                        );
                    } else
                        bytes = get(name).subarray(
                            Number(position),
                            Number(position) + Math.min(length, 4093),
                        );
                    bytes.copy(buffer, offset);
                    return { bytesRead: bytes.length };
                },
                close: async () => {},
            };
        },
    };
    return { io, files, registry, fixture };
}

test("kernel helper recursion sentinel is exactly1; zero and ordinary bounded limits are refused", () => {
    assert.deepEqual(
        assertNativeCollectorLimits("Max core file size   1  1  bytes\n"),
        { coreSoftBytes: 1, coreHardBytes: 1 },
    );
    for (const values of [
        "0 0",
        "1 0",
        "33554432 33554432",
        "unlimited unlimited",
    ])
        assert.throws(
            () =>
                assertNativeCollectorLimits(
                    `Max core file size ${values} bytes\n`,
                ),
            /sentinel/,
        );
});

test("registered generation-zero identities derive from the actual runtime manifest and reject arbitrary or repeated actors", () => {
    const { registry } = fixtureIo();
    assert.equal(validateNativeRegistry(registry), registry);
    for (const change of [
        (value) => (value.actors[0].generation = 1),
        (value) => (value.actors[0].filename = "/bin/sh"),
        (value) => value.actors.push({ ...value.actors[0] }),
        (value) => (value.extra = true),
    ]) {
        const value = structuredClone(registry);
        change(value);
        assert.throws(() => validateNativeRegistry(value));
    }
    const selected = resolveRuntimeLayout("/workbench").processes.find(
        (item) => item.id === "sync",
    );
    registry.probe = false;
    registry.actors = [
        {
            id: selected.id,
            filename: selected.filename,
            generation: 0,
            pid: 404,
        },
    ];
    assert.equal(validateNativeRegistry(registry), registry);
});

test("bounded pipe collection keeps raw bytes intact, distinguishes fault TID from actor leader and derives independently sourced windows", async () => {
    const state = fixtureIo(nativeCoreWireFixture({ tid: 707 }));
    const input = Readable.from([
        state.fixture.raw.subarray(0, 61),
        state.fixture.raw.subarray(61),
    ]);
    const receipt = await collectNativeCore({
        pid: state.fixture.pid,
        signalNumber: 11,
        input,
        io: state.io,
    });
    assert.equal(receipt.complete, true, receipt.error);
    assert.equal(receipt.memoryComplete, true);
    assert.equal(receipt.actor.pid, 404);
    assert.equal(receipt.notes.crashingThread.tid, 707);
    assert.equal(receipt.raw.sha256, hash(state.fixture.raw));
    assert.deepEqual(
        state.files.get(`${directory}/${POLICY.raw}`),
        state.fixture.raw,
    );
    assert.equal(
        state.files
            .get(`${directory}/stack.bin`)
            .readBigUInt64LE(receipt.windows.stack.registerOffset),
        0x400110n,
    );
    assert.equal(receipt.derived.rawSha256, receipt.raw.sha256);
    assert.equal(
        receipt.windows.instructions.sha256,
        hash(state.files.get(`${directory}/instructions.bin`)),
    );
    assert.equal(receipt.helperLimits.coreHardBytes, 1);
    assert.match(receipt.fd0Lifetime, /retained-through/);
    await assert.rejects(
        collectNativeCore({
            pid: 404,
            signalNumber: 11,
            input: Readable.from([state.fixture.raw]),
            io: state.io,
        }),
        /EEXIST/,
    );
    assert.deepEqual(
        state.files.get(`${directory}/${POLICY.raw}`),
        state.fixture.raw,
    );
});

test("unknown PID and bad helper policy cannot claim a dump or read process memory", async () => {
    const state = fixtureIo();
    await assert.rejects(
        collectNativeCore({
            pid: 405,
            signalNumber: 11,
            input: Readable.from([]),
            io: state.io,
        }),
        /registered/,
    );
    assert.equal(state.files.has(`${directory}/${POLICY.claim}`), false);
    state.files.set(
        "/proc/self/limits",
        Buffer.from("Max core file size 0 0 bytes\n"),
    );
    await assert.rejects(
        collectNativeCore({
            pid: 404,
            signalNumber: 11,
            input: Readable.from([]),
            io: state.io,
        }),
        /sentinel/,
    );
    assert.equal(state.files.has(`${directory}/${POLICY.claim}`), false);
});

test("oversized, truncated and disappearing task captures remain explicit incomplete evidence", async () => {
    for (const type of ["oversized", "truncated", "gone"]) {
        const state = fixtureIo();
        if (type === "gone")
            state.files.delete(`/proc/${state.fixture.pid}/maps`);
        const bytes =
            type === "oversized"
                ? Buffer.alloc(CORE.bytes + 1)
                : type === "truncated"
                  ? state.fixture.raw.subarray(0, 70)
                  : state.fixture.raw;
        const receipt = await collectNativeCore({
            pid: 404,
            signalNumber: 11,
            input: Readable.from([bytes]),
            io: state.io,
        });
        assert.equal(receipt.complete, false);
        assert.equal(receipt.memoryComplete, false);
        assert.ok(receipt.error);
        assert.equal(
            JSON.parse(state.files.get(`${directory}/${POLICY.receipt}`))
                .complete,
            false,
        );
        assert.equal(state.files.has(`${directory}/${POLICY.derived}`), false);
    }
});

test("every actual collector entry refuses host execution before fd0 or policy mutation", async () => {
    await assert.rejects(
        runNativeCoreCollector(["404", "11"]),
        /private replay guest/,
    );
    await assert.rejects(
        prepareRegisteredNativeDiagnostics({
            settings: { profile: PROFILE.RegisteredContext },
            root: "/host",
            output: "/host/output",
        }),
        /private replay guest/,
    );
});

test("v2 prepares only the private guest and registers real generation-zero runtime actors without changing Node argv", async () => {
    const state = fixtureIo();
    state.files.set("/proc/sys/kernel/core_pattern", Buffer.from("core\n"));
    state.files.set("/proc/sys/kernel/core_pipe_limit", Buffer.from("0\n"));
    state.files.set("/proc/self/coredump_filter", Buffer.from("00000033\n"));
    state.files.set(CORE.executable, Buffer.from("fake prlimit"));
    const io = {
        ...state.io,
        mkdir: async () => {},
        rename: async (from, to) => {
            state.files.set(to, state.files.get(from));
            state.files.delete(from);
        },
        writeFile: async (name, bytes, options) =>
            state.io.writeFile(
                name,
                name === "/proc/self/coredump_filter" ? "00000010\n" : bytes,
                options,
            ),
    };
    const pin = async (filename) => ({
        path: filename,
        sizeBytes: 10,
        sha256: "a".repeat(64),
    });
    const diagnostics = await prepareRegisteredNativeDiagnostics({
        settings: { profile: PROFILE.RegisteredContext },
        root: "/workbench",
        output: "/workbench/output",
        io,
        pin,
    });
    const sync = resolveRuntimeLayout("/workbench").processes.find(
        (item) => item.id === "sync",
    );
    const generationOne = { ...sync, generation: 1 };
    assert.deepEqual(
        diagnostics.launchCommand(generationOne, process.execPath, [
            sync.filename,
        ]),
        { file: process.execPath, args: [sync.filename] },
    );
    assert.equal(
        diagnostics.launchCommand(sync, process.execPath, [sync.filename]).file,
        CORE.executable,
    );
    const child = { pid: 123, signalCode: null };
    await diagnostics.track(sync, child);
    state.files.set(
        "/proc/123/limits",
        Buffer.from(`Max core file size ${CORE.bytes} ${CORE.bytes} bytes\n`),
    );
    state.files.set("/proc/123/coredump_filter", Buffer.from(CORE.filter));
    state.files.set(
        "/proc/123/cmdline",
        Buffer.from(`${process.execPath}\0${sync.filename}\0`),
    );
    await diagnostics.verifyRuntime(sync, child);
    const registered = validateNativeRegistry(
        JSON.parse(state.files.get(`${directory}/${POLICY.registry}`)),
    );
    assert.equal(registered.actors[0].id, sync.id);
    assert.equal(registered.actors[0].pid, 123);
    const receipt = await diagnostics.capture();
    assert.equal(receipt.effective.corePipeLimit, "1");
    assert.equal(receipt.missing, false);
    assert.deepEqual(receipt.effective.actors[0].argv, [
        process.execPath,
        sync.filename,
    ]);
    child.signalCode = "SIGSEGV";
    const missing = await diagnostics.capture();
    assert.equal(missing.coreExpected, true);
    assert.equal(missing.missing, true);
    assert.equal(missing.fatalActors[0].id, sync.id);
    await assert.rejects(diagnostics.track(sync, child), /unique real/);
});

test("a stalled core producer is stopped by the fixed deadline and does not accumulate unbounded input", async () => {
    const { writeNativeCoreStream } =
        await import("./native-core-collector.mjs");
    const input = new Readable({ read() {} });
    let cancelled = false,
        written = false;
    await assert.rejects(
        writeNativeCoreStream(
            input,
            {
                write: async () => {
                    written = true;
                },
            },
            {
                schedule: (callback, timeout) => {
                    assert.equal(timeout, POLICY.timeoutMs);
                    queueMicrotask(callback);
                    return 101;
                },
                cancel: (timer) => {
                    assert.equal(timer, 101);
                    cancelled = true;
                },
            },
        ),
        /deadline/,
    );
    assert.equal(input.destroyed, true);
    assert.equal(written, false);
    assert.equal(cancelled, true);
});

test("the owned core pipe descriptor remains open after EOF and stream destruction until its owner closes it", async () => {
    const { open, writeFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { createArtifactRunDirectory } = await import("../artifacts.mjs");
    const { createNativeCoreInput } =
        await import("./native-core-collector.mjs");
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const directory = await createArtifactRunDirectory(
        `${root}/tmp/simulation-native-core-tests`,
        "reader-",
    );
    const filename = `${directory}/inert-core-input`;
    await writeFile(filename, "inert fixture data");
    const handle = await open(filename, "r");
    const input = createNativeCoreInput(handle.fd);
    try {
        const chunks = [];
        for await (const chunk of input) chunks.push(chunk);
        assert.equal(Buffer.concat(chunks).toString(), "inert fixture data");
        assert.equal((await handle.stat()).isFile(), true);
        await new Promise((resolve) => {
            input.once("close", resolve);
            input.destroy();
        });
        const bytes = Buffer.alloc(5);
        const result = await handle.read({ buffer: bytes, position: 0n });
        assert.equal(result.bytesRead, 5);
        assert.equal(bytes.toString(), "inert");
    } finally {
        await handle.close();
    }
});

test("coordinator readback rechecks retained raw/window/derived pins and refuses changed memory evidence", async () => {
    const state = fixtureIo();
    const helper = await collectNativeCore({
        pid: 404,
        signalNumber: 11,
        input: Readable.from([state.fixture.raw]),
        io: state.io,
    });
    assert.equal(helper.complete, true);
    for (const [name, value] of [
        ["/proc/sys/kernel/core_pattern", "core"],
        ["/proc/sys/kernel/core_pipe_limit", "0"],
        ["/proc/self/coredump_filter", "00000033"],
        [CORE.executable, "inert prlimit"],
    ])
        state.files.set(name, Buffer.from(value));
    const io = {
        ...state.io,
        mkdir: async () => {},
        rename: async (from, to) => state.files.set(to, state.files.get(from)),
        writeFile: async (filename, bytes, options) =>
            state.io.writeFile(
                filename,
                filename === "/proc/self/coredump_filter" ? CORE.filter : bytes,
                options,
            ),
    };
    const diagnostics = await prepareRegisteredNativeDiagnostics({
        settings: { profile: PROFILE.RegisteredContext },
        root: "/workbench",
        output: "/workbench/output",
        actorId: NATIVE_DIAGNOSTIC_ACTOR.Probe,
        io,
        pin: async (filename) => ({
            path: filename,
            sizeBytes: 126,
            sha256: "a".repeat(64),
        }),
    });
    await diagnostics.track(
        {
            id: NATIVE_DIAGNOSTIC_ACTOR.Probe,
            generation: 0,
            filename: state.fixture.filename,
        },
        { pid: 404, signalCode: "SIGSEGV" },
    );
    const { recordNativeCoreTimeout } =
        await import("./native-core-collector.mjs");
    recordNativeCoreTimeout(
        { helperPid: 888, pid: 405, signalNumber: 11 },
        (filename, bytes) => state.files.set(filename, Buffer.from(bytes)),
    );
    const capture = await diagnostics.capture();
    assert.equal(capture.helperTimeout.authoritative, false);
    assert.equal(capture.helperTimeout.registeredActor, null);
    assert.equal(capture.collector.actor.pid, 404);
    assert.equal(capture.error, undefined);
    assert.equal(capture.missing, false);
    assert.equal(capture.cores[0].sha256, hash(state.fixture.raw));
    const changed = Buffer.from(state.files.get(`${directory}/stack.bin`));
    changed[128] ^= 1;
    state.files.set(`${directory}/stack.bin`, changed);
    const refused = await diagnostics.capture();
    assert.match(refused.error, /pin changed/);
    assert.equal(refused.missing, true);
    assert.deepEqual(
        state.files.get(`${directory}/${POLICY.raw}`),
        state.fixture.raw,
    );
});

test("a later unregistered helper timeout cannot overwrite the first claimed receipt, core or a prior timeout", async () => {
    const { recordNativeCoreTimeout, validateNativeCoreTimeout } =
        await import("./native-core-collector.mjs");
    const state = fixtureIo();
    await collectNativeCore({
        pid: 404,
        signalNumber: 11,
        input: Readable.from([state.fixture.raw]),
        io: state.io,
    });
    const first = Buffer.from(
            state.files.get(`${directory}/${POLICY.receipt}`),
        ),
        raw = Buffer.from(state.files.get(`${directory}/${POLICY.raw}`));
    const write = (filename, bytes, options) => {
        assert.equal(filename, `${directory}/${POLICY.timeoutArtifact}`);
        assert.equal(options.flag, "wx");
        if (state.files.has(filename))
            throw Object.assign(new Error("already retained"), {
                code: "EEXIST",
            });
        state.files.set(filename, Buffer.from(bytes));
    };
    assert.equal(
        recordNativeCoreTimeout(
            { helperPid: 888, pid: 405, signalNumber: 11 },
            write,
        ),
        true,
    );
    const timeout = Buffer.from(
        state.files.get(`${directory}/${POLICY.timeoutArtifact}`),
    );
    const receipt = validateNativeCoreTimeout(JSON.parse(timeout));
    assert.equal(receipt.authoritative, false);
    assert.equal(receipt.complete, false);
    assert.equal(receipt.pid, 405);
    assert.equal(
        recordNativeCoreTimeout(
            { helperPid: 889, pid: 406, signalNumber: 11 },
            write,
        ),
        false,
    );
    assert.deepEqual(
        state.files.get(`${directory}/${POLICY.timeoutArtifact}`),
        timeout,
    );
    assert.deepEqual(state.files.get(`${directory}/${POLICY.receipt}`), first);
    assert.deepEqual(state.files.get(`${directory}/${POLICY.raw}`), raw);
    for (const change of [
        (value) => (value.authoritative = true),
        (value) => (value.profile = "unknown"),
        (value) => (value.helperPid = 0),
        (value) => (value.pid = "405"),
        (value) => (value.signalNumber = 65),
        (value) => value.deadlineMs++,
        (value) => (value.extra = true),
    ]) {
        const value = structuredClone(receipt);
        change(value);
        assert.throws(() => validateNativeCoreTimeout(value));
    }
});
