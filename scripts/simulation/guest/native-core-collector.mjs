import * as filesystem from "node:fs/promises";
import { createReadStream, closeSync, writeFileSync, read } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pinFile } from "../artifacts.mjs";
import { resolveRuntimeLayout } from "./runtime-manifest.mjs";
import { parseElfCoreNotes } from "./elf-core-notes.mjs";
import {
    enrichElfCoreMemory,
    ELF_CORE_MEMORY_LIMITS,
} from "./elf-core-memory.mjs";
import {
    parseNativeProcessMaps,
    readNativeProcText,
    readNativeMemoryWindows,
} from "./native-core-memory.mjs";
import {
    assertPrivateNativeGuest,
    assertNativeCoreLimits,
    validateNativeDiagnostics,
    nativeCoreLimitCommand,
    NATIVE_CORE_POLICY as CORE,
    NATIVE_CORE_CONTEXT_POLICY as POLICY,
    NATIVE_DIAGNOSTIC_ACTOR,
    NATIVE_DIAGNOSTIC_PROFILE,
    NATIVE_MEMORY_WINDOW,
} from "./native-failure-evidence.mjs";

const ROOT = "/workbench",
    OUTPUT = `${ROOT}/output`;
const DIRECTORY = `${OUTPUT}/${CORE.directory}`;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fatalSignals = new Set([
    "SIGSEGV",
    "SIGBUS",
    "SIGILL",
    "SIGABRT",
    "SIGFPE",
    "SIGTRAP",
    "SIGSYS",
    "SIGQUIT",
]);
const artifact = (name) => `${CORE.directory}/${name}`;
const message = (error) => String(error.message).slice(0, 1024);
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function registeredSpecs() {
    const layout = resolveRuntimeLayout(ROOT);
    return [...layout.processes, ...layout.bootstrapProcesses];
}
function admittedSpec(spec, probe) {
    if ((spec.generation ?? 0) !== 0) return false;
    if (probe)
        return (
            spec.id === NATIVE_DIAGNOSTIC_ACTOR.Probe &&
            spec.filename === `${OUTPUT}/native-probe/null-write`
        );
    return registeredSpecs().some(
        (item) => item.id === spec.id && item.filename === spec.filename,
    );
}

/** The helper's {1,1} limit is a pinned-kernel recursion sentinel, NOT its input cap.
 * Linux 6.6.71 fs/coredump.c supplies it to pipe helpers and refuses recursion at 1.
 */
export function assertNativeCollectorLimits(text) {
    if (!/^Max core file size\s+1\s+1\s+bytes\s*$/m.test(text))
        throw new Error(
            "Pipe helper did not retain the kernel recursion sentinel",
        );
    return {
        coreSoftBytes: POLICY.helperCoreBytes,
        coreHardBytes: POLICY.helperCoreBytes,
    };
}

export function validateNativeRegistry(value) {
    if (
        !value ||
        Object.keys(value).sort().join(",") !==
            "actors,coordinatorPid,probe,version" ||
        value.version !== 1 ||
        typeof value.probe !== "boolean" ||
        !Number.isSafeInteger(value.coordinatorPid) ||
        value.coordinatorPid < 2 ||
        !Array.isArray(value.actors) ||
        value.actors.length > registeredSpecs().length
    )
        throw new Error("Invalid native diagnostic registry");
    const ids = new Set(),
        pids = new Set();
    for (const actor of value.actors) {
        if (
            !actor ||
            Object.keys(actor).sort().join(",") !==
                "filename,generation,id,pid" ||
            actor.generation !== 0 ||
            !Number.isSafeInteger(actor.pid) ||
            actor.pid < 2 ||
            ids.has(actor.id) ||
            pids.has(actor.pid) ||
            !admittedSpec(actor, value.probe)
        )
            throw new Error("Unregistered native diagnostic actor identity");
        ids.add(actor.id);
        pids.add(actor.pid);
    }
    return value;
}

async function boundedJson(io, filename, maximum = POLICY.registryBytes) {
    const metadata = await io.lstat(filename);
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximum)
        throw new Error("Expected a bounded regular diagnostic JSON artifact");
    const bytes = await io.readFile(filename);
    if (bytes.length !== metadata.size)
        throw new Error("Diagnostic JSON changed during read");
    return JSON.parse(bytes.toString("utf8"));
}

async function pinGuestLibrary(io, pin, filename) {
    const absolute = path.resolve(filename);
    if (
        absolute !== filename ||
        !["/usr/lib/", "/lib/", "/workbench/runtime/"].some((prefix) =>
            absolute.startsWith(prefix),
        )
    )
        throw new Error(
            "Fault file is outside the admitted guest runtime/library roots",
        );
    const metadata = await io.stat(filename);
    if (
        !metadata.isFile() ||
        metadata.size < 1 ||
        metadata.size > 256 * 1024 * 1024
    )
        throw new Error("Fault library is not a bounded regular guest file");
    const result = await pin(filename);
    if (result.sizeBytes !== metadata.size)
        throw new Error("Guest fault library changed during pinning");
    return result;
}

async function assertPinnedCapture(io, item, filename, maximum) {
    if (
        !item ||
        item.file !== artifact(filename) ||
        !Number.isSafeInteger(item.sizeBytes) ||
        item.sizeBytes < 1 ||
        item.sizeBytes > maximum ||
        !/^[0-9a-f]{64}$/.test(item.sha256)
    )
        throw new Error("Invalid bounded collector artifact pin");
    const file = path.join(DIRECTORY, filename),
        metadata = await io.lstat(file);
    if (!metadata.isFile() || metadata.size !== item.sizeBytes)
        throw new Error("Collector artifact is not the pinned regular file");
    const bytes = await io.readFile(file);
    if (bytes.length !== item.sizeBytes || sha(bytes) !== item.sha256)
        throw new Error("Collector artifact pin changed");
}

/** One first-fault budget across registered generation-zero Node actors. Broker,
 * one-shot maintenance and restarted generations remain explicitly outside it.
 */
export async function prepareRegisteredNativeDiagnostics({
    settings,
    root,
    output,
    actorId,
    io = filesystem,
    pin = pinFile,
}) {
    validateNativeDiagnostics(settings);
    if (settings.profile !== NATIVE_DIAGNOSTIC_PROFILE.RegisteredContext)
        throw new Error(
            "The collector owner requires the explicit registered-context profile",
        );
    await assertPrivateNativeGuest({ root, output, io });
    const directory = path.join(output, CORE.directory);
    await io.mkdir(directory, { mode: 0o700 });
    const original = {
        corePattern: (
            await io.readFile("/proc/sys/kernel/core_pattern", "utf8")
        ).trim(),
        coredumpFilter: (
            await io.readFile("/proc/self/coredump_filter", "utf8")
        ).trim(),
        corePipeLimit: (
            await io.readFile("/proc/sys/kernel/core_pipe_limit", "utf8")
        ).trim(),
    };
    await io.writeFile(
        "/proc/sys/kernel/core_pipe_limit",
        String(POLICY.pipeLimit),
    );
    await io.writeFile("/proc/self/coredump_filter", "0x10");
    await io.writeFile("/proc/sys/kernel/core_pattern", POLICY.pattern);
    const effective = {
        corePattern: (
            await io.readFile("/proc/sys/kernel/core_pattern", "utf8")
        ).trim(),
        coredumpFilter: (
            await io.readFile("/proc/self/coredump_filter", "utf8")
        ).trim(),
        corePipeLimit: (
            await io.readFile("/proc/sys/kernel/core_pipe_limit", "utf8")
        ).trim(),
        actors: [],
    };
    if (
        effective.corePattern !== POLICY.pattern ||
        effective.coredumpFilter !== CORE.filter ||
        effective.corePipeLimit !== String(POLICY.pipeLimit)
    )
        throw new Error(
            "Guest pipe policy read-back differs from the requested profile",
        );
    const toolMetadata = await io.lstat(CORE.executable);
    if (
        !toolMetadata.isFile() ||
        toolMetadata.size < 1 ||
        toolMetadata.size > 2 * 1024 * 1024
    )
        throw new Error("Missing admitted guest prlimit");
    const receipt = {
        version: 2,
        profile: settings.profile,
        original,
        effective,
        requested: {
            rawBytes: CORE.bytes,
            stackBytes: POLICY.stackBytes,
            instructionBytes: POLICY.instructionBytes,
            timeoutMs: POLICY.timeoutMs,
            firstRegisteredFaultOnly: true,
            generation: 0,
        },
        tool: await pin(CORE.executable),
        node: await pin(process.execPath),
        scope: "registered-generation-zero-node-actors-or-explicit-synthetic-probe",
        omitted: "NATS, one-shot maintenance and restarted generations",
        cores: [],
    };
    const probe = actorId === NATIVE_DIAGNOSTIC_ACTOR.Probe;
    const registry = {
        version: 1,
        coordinatorPid: process.pid,
        probe,
        actors: [],
    };
    const targets = new Map();
    const persist = () =>
        io.writeFile(path.join(output, CORE.artifact), json(receipt));
    let registryWrites = Promise.resolve();
    const persistRegistry = () =>
        (registryWrites = registryWrites.then(async () => {
            const filename = path.join(directory, POLICY.registry);
            await io.writeFile(`${filename}.pending`, json(registry), {
                mode: 0o600,
            });
            await io.rename(`${filename}.pending`, filename);
        }));
    await persistRegistry();
    await persist();
    const selected = (spec) => admittedSpec(spec, probe);
    return {
        launchCommand(spec, executable, args) {
            if (!selected(spec)) return { file: executable, args };
            if (targets.has(spec.id))
                throw new Error(
                    "Diagnostic actor generation was already registered",
                );
            return nativeCoreLimitCommand(executable, args);
        },
        async track(spec, child) {
            if (!selected(spec)) return;
            if (
                targets.has(spec.id) ||
                !Number.isSafeInteger(child.pid) ||
                child.pid < 2 ||
                [...targets.values()].some(
                    (target) => target.child.pid === child.pid,
                )
            )
                throw new Error("A unique real diagnostic child is required");
            targets.set(spec.id, { spec, child });
            const actor = {
                id: spec.id,
                generation: 0,
                pid: child.pid,
                filename: spec.filename,
            };
            registry.actors.push(actor);
            effective.actors.push({ ...actor });
            await persistRegistry();
            await persist();
        },
        async verifyRuntime(spec, child) {
            if (!selected(spec)) return;
            if (targets.get(spec.id)?.child !== child)
                throw new Error("Diagnostic actor identity changed");
            const prefix = `/proc/${child.pid}`;
            const [limits, filter, exe, command] = await Promise.all([
                io.readFile(`${prefix}/limits`, "utf8"),
                io.readFile(`${prefix}/coredump_filter`, "utf8"),
                io.readlink(`${prefix}/exe`),
                io.readFile(`${prefix}/cmdline`),
            ]);
            const argv = command.toString("utf8").split("\0").filter(Boolean);
            if (
                exe !== process.execPath ||
                argv.length !== 2 ||
                argv[0] !== process.execPath ||
                argv[1] !== spec.filename
            )
                throw new Error(
                    "Diagnostic actor changed its real Node executable or argv",
                );
            Object.assign(
                effective.actors.find((actor) => actor.pid === child.pid),
                assertNativeCoreLimits(limits, filter),
                { exe, argv },
            );
            await persist();
        },
        async verifyProbeReceipt({ limits, filter, pid, filename }) {
            if (
                !probe ||
                targets.get(NATIVE_DIAGNOSTIC_ACTOR.Probe)?.child.pid !== pid ||
                registry.actors[0]?.filename !== filename
            )
                throw new Error("Synthetic native probe identity changed");
            Object.assign(
                effective.actors[0],
                assertNativeCoreLimits(limits, filter),
                {
                    exe: filename,
                    argv: [filename],
                    receipt: "fixed-pre-exec-probe-wrapper",
                },
            );
            await persist();
        },
        async capture() {
            receipt.coreExpected = [...targets.values()].some((target) =>
                fatalSignals.has(target.child.signalCode),
            );
            receipt.cores = [];
            try {
                const timeout = validateNativeCoreTimeout(
                    await boundedJson(
                        io,
                        path.join(directory, POLICY.timeoutArtifact),
                        POLICY.timeoutBytes,
                    ),
                );
                receipt.helperTimeout = {
                    ...timeout,
                    registeredActor:
                        registry.actors.find(
                            (actor) => actor.pid === timeout.pid,
                        ) ?? null,
                };
            } catch (error) {
                if (error.code !== "ENOENT")
                    receipt.helperTimeoutError = message(error);
            }
            receipt.fatalActors = [...targets.values()]
                .filter((target) => fatalSignals.has(target.child.signalCode))
                .map((target) => ({
                    id: target.spec.id,
                    pid: target.child.pid,
                    signal: target.child.signalCode,
                }));
            try {
                const capture = await boundedJson(
                    io,
                    path.join(directory, POLICY.receipt),
                    POLICY.receiptBytes,
                );
                receipt.collector = capture;
                if (
                    capture.version !== 2 ||
                    capture.profile !==
                        NATIVE_DIAGNOSTIC_PROFILE.RegisteredContext ||
                    typeof capture.complete !== "boolean" ||
                    typeof capture.memoryComplete !== "boolean"
                )
                    throw new Error(
                        "Unsupported or incomplete collector receipt identity",
                    );
                if (capture.actor) {
                    const target = registry.actors.find(
                        (actor) => actor.pid === capture.actor.pid,
                    );
                    if (
                        !target ||
                        JSON.stringify(target) !== JSON.stringify(capture.actor)
                    )
                        throw new Error(
                            "Collector receipt does not match the admitted actor registry",
                        );
                }
                if (capture.maps)
                    await assertPinnedCapture(
                        io,
                        capture.maps,
                        POLICY.maps,
                        POLICY.mapsBytes,
                    );
                for (const [kind, window] of Object.entries(
                    capture.windows ?? {},
                )) {
                    if (!Object.values(NATIVE_MEMORY_WINDOW).includes(kind))
                        throw new Error("Unknown collector memory window");
                    if (window.file)
                        await assertPinnedCapture(
                            io,
                            window,
                            `${kind}.bin`,
                            kind === NATIVE_MEMORY_WINDOW.Stack
                                ? POLICY.stackBytes
                                : POLICY.instructionBytes,
                        );
                }
                if (capture.derived)
                    await assertPinnedCapture(
                        io,
                        capture.derived,
                        POLICY.derived,
                        ELF_CORE_MEMORY_LIMITS.derivedBytes,
                    );
                if (capture.raw) {
                    const filename = path.join(directory, POLICY.raw),
                        metadata = await io.lstat(filename);
                    if (
                        !metadata.isFile() ||
                        metadata.size < 1 ||
                        metadata.size > CORE.bytes
                    )
                        throw new Error(
                            "Collector raw core is not a bounded regular artifact",
                        );
                    const bytes = await io.readFile(filename);
                    if (
                        bytes.length !== capture.raw.sizeBytes ||
                        sha(bytes) !== capture.raw.sha256
                    )
                        throw new Error("Collector raw core pin changed");
                    const notes = parseElfCoreNotes(bytes);
                    if (
                        notes.process?.pid !== capture.actor.pid ||
                        notes.signal?.number !== capture.signalNumber
                    )
                        throw new Error(
                            "Raw core and collector identity disagree",
                        );
                    const executable = probe
                        ? capture.actor.filename
                        : process.execPath;
                    const files = {
                        executable: await pin(executable),
                        phase: "coordinator-after-helper-completion",
                        unresolvedLibraryPolicy: "never-use-host-libraries",
                    };
                    if (
                        !probe &&
                        (files.executable.sha256 !== receipt.node.sha256 ||
                            files.executable.sizeBytes !==
                                receipt.node.sizeBytes)
                    )
                        throw new Error("Admitted guest Node bytes changed");
                    const faultFile = notes.fileMapping?.file;
                    if (faultFile && !faultFile.endsWith(" (deleted)")) {
                        try {
                            files.instructions =
                                faultFile === executable
                                    ? files.executable
                                    : await pinGuestLibrary(io, pin, faultFile);
                        } catch (error) {
                            files.instructionPinError = message(error);
                        }
                    }
                    receipt.files = files;
                    receipt.cores.push({
                        file: artifact(POLICY.raw),
                        pid: capture.actor.pid,
                        signalNumber: capture.signalNumber,
                        ...capture.raw,
                        ...notes,
                        capReached: bytes.length === CORE.bytes,
                        threadCount: notes.threads.length,
                        fileCount: notes.files.length,
                    });
                }
            } catch (error) {
                if (error.code !== "ENOENT" || receipt.coreExpected)
                    receipt.error = message(error);
            }
            receipt.uncapturedFatalActors = receipt.fatalActors.filter(
                (actor) =>
                    !receipt.cores.some((core) => core.pid === actor.pid),
            );
            receipt.missing = receipt.coreExpected && !receipt.cores.length;
            await persist().catch((error) => {
                receipt.artifactError = message(error);
            });
            return structuredClone(receipt);
        },
    };
}

/** The FD owner, not stream teardown/async iteration, releases the kernel task.
 * A no-op stream close also preserves the descriptor on error/timeout paths. */
export function createNativeCoreInput(fd) {
    return createReadStream(null, {
        fd,
        autoClose: false,
        fs: { read, close: (_fd, callback) => callback(null) },
    });
}

/** Bound a stalled producer as well as byte volume. The outer helper deadline
 * additionally covers filesystem/proc work after EOF. The stream owns no fd0
 * close: the real input has autoClose=false and the caller closes it last. */
export async function writeNativeCoreStream(
    input,
    handle,
    { schedule = setTimeout, cancel = clearTimeout } = {},
) {
    const timer = schedule(
        () => input.destroy(new Error("Native core input deadline exceeded")),
        POLICY.timeoutMs,
    );
    const hash = createHash("sha256");
    let size = 0;
    try {
        for await (const chunk of input) {
            if (!Buffer.isBuffer(chunk) || size + chunk.length > CORE.bytes)
                throw new Error(
                    "Core input exceeds its bounded raw-byte policy",
                );
            let written = 0;
            while (written < chunk.length) {
                const result = await handle.write(
                    chunk,
                    written,
                    chunk.length - written,
                );
                if (!result.bytesWritten)
                    throw new Error("Short core artifact write");
                written += result.bytesWritten;
            }
            hash.update(chunk);
            size += chunk.length;
        }
        return { sizeBytes: size, sha256: hash.digest("hex") };
    } finally {
        cancel(timer);
    }
}

/** Consume a kernel pipe only inside the admitted guest. Keep fd0 OPEN after
 * EOF: Linux waits on reader count, not helper PID, while /proc/mm is retained.
 * The caller owns the hard timeout and closes fd0 after this function finishes.
 */
export async function collectNativeCore({
    pid,
    signalNumber,
    input,
    io = filesystem,
    pin = pinFile,
}) {
    await assertPrivateNativeGuest({ root: ROOT, output: OUTPUT, io });
    if (
        !Number.isSafeInteger(pid) ||
        pid < 2 ||
        !Number.isSafeInteger(signalNumber) ||
        signalNumber < 1 ||
        signalNumber > 64
    )
        throw new Error("Invalid kernel collector identity");
    const registry = validateNativeRegistry(
        await boundedJson(io, path.join(DIRECTORY, POLICY.registry)),
    );
    const actor = registry.actors.find((actor) => actor.pid === pid);
    if (!actor)
        throw new Error("Fault PID is not a registered diagnostic actor");
    const helperLimits = assertNativeCollectorLimits(
        await readNativeProcText(io, "/proc/self/limits", 8192),
    );
    const expectedExe = registry.probe ? actor.filename : process.execPath;
    if ((await io.readlink(`/proc/${pid}/exe`)) !== expectedExe)
        throw new Error(
            "Fault executable differs from its registered identity",
        );
    await io.writeFile(
        path.join(DIRECTORY, POLICY.claim),
        json({ actor, signalNumber }),
        { flag: "wx", mode: 0o600 },
    );
    const receipt = {
        version: 2,
        profile: NATIVE_DIAGNOSTIC_PROFILE.RegisteredContext,
        actor,
        signalNumber,
        helperLimits,
        complete: false,
        memoryComplete: false,
        fd0Lifetime: "retained-through-proc-memory-capture",
        unwindStatus: "not-attempted-requires-matching-guest-files",
    };
    const persist = () =>
        io.writeFile(path.join(DIRECTORY, POLICY.receipt), json(receipt), {
            mode: 0o600,
        });
    await persist();
    try {
        const rawFile = await io.open(
            path.join(DIRECTORY, POLICY.raw),
            "wx",
            0o600,
        );
        try {
            receipt.raw = await writeNativeCoreStream(input, rawFile);
        } finally {
            await rawFile.close();
        }
        const raw = await io.readFile(path.join(DIRECTORY, POLICY.raw));
        if (
            raw.length !== receipt.raw.sizeBytes ||
            sha(raw) !== receipt.raw.sha256
        )
            throw new Error("Raw core changed during readback");
        const notes = parseElfCoreNotes(raw);
        if (
            !notes.notesComplete ||
            !notes.loadSegmentsComplete ||
            notes.process?.pid !== pid ||
            notes.signal.number !== signalNumber
        )
            throw new Error(
                "Raw core notes do not identify the complete registered fatal dump",
            );
        receipt.notes = {
            process: notes.process,
            signal: notes.signal,
            crashingThread: notes.crashingThread,
            threadSelection: notes.threadSelection,
            fileMapping: notes.fileMapping,
        };
        const mapsText = await readNativeProcText(
            io,
            `/proc/${pid}/maps`,
            POLICY.mapsBytes,
        );
        const maps = parseNativeProcessMaps(mapsText);
        await io.writeFile(path.join(DIRECTORY, POLICY.maps), mapsText, {
            flag: "wx",
            mode: 0o600,
        });
        receipt.maps = {
            file: artifact(POLICY.maps),
            sizeBytes: Buffer.byteLength(mapsText),
            sha256: sha(Buffer.from(mapsText)),
            entries: maps.length,
        };
        const windows = await readNativeMemoryWindows(io, pid, notes, maps);
        receipt.windows = {};
        const captured = [];
        for (const [kind, window] of Object.entries(windows)) {
            const { bytes, ...metadata } = window;
            receipt.windows[kind] = metadata;
            if (bytes?.length) {
                const file = `${kind}.bin`;
                await io.writeFile(path.join(DIRECTORY, file), bytes, {
                    flag: "wx",
                    mode: 0o600,
                });
                Object.assign(receipt.windows[kind], {
                    file: artifact(file),
                    sizeBytes: bytes.length,
                    sha256: sha(bytes),
                });
                captured.push({ kind, address: window.address, bytes });
            }
        }
        receipt.memoryComplete = Object.values(windows).every(
            (window) => window.complete,
        );
        // Hashing a 100+ MiB Node executable is outside the retained-mm window.
        // The coordinator pins these exact guest paths after helper completion.
        receipt.files = {
            executable: expectedExe,
            instructions: notes.fileMapping?.file ?? null,
            pinStatus: "pending-coordinator-guest-file-readback",
        };
        if (captured.length) {
            const derived = enrichElfCoreMemory(raw, captured);
            await io.writeFile(
                path.join(DIRECTORY, POLICY.derived),
                derived.bytes,
                { flag: "wx", mode: 0o600 },
            );
            receipt.derived = {
                file: artifact(POLICY.derived),
                sizeBytes: derived.bytes.length,
                sha256: sha(derived.bytes),
                evidence: derived.evidence,
                rawSha256: derived.rawSha256,
                rawSizeBytes: derived.rawSizeBytes,
                ranges: derived.provenance,
            };
        }
        receipt.complete = true;
    } catch (error) {
        receipt.error = message(error);
    }
    await persist();
    return receipt;
}

/** A timeout is NONAUTHORITATIVE: admission/claim may not have completed.
 * Its fixed wx sidecar cannot replace any earlier claimed core receipt/pins. */
export function validateNativeCoreTimeout(value) {
    const keys =
        "authoritative,complete,deadlineMs,helperPid,memoryComplete,pid,profile,signalNumber,timedOut,version";
    if (
        !value ||
        Object.keys(value).sort().join(",") !== keys ||
        value.version !== 2 ||
        value.profile !== NATIVE_DIAGNOSTIC_PROFILE.RegisteredContext ||
        value.authoritative !== false ||
        value.complete !== false ||
        value.memoryComplete !== false ||
        value.timedOut !== true ||
        value.deadlineMs !== POLICY.timeoutMs ||
        !Number.isSafeInteger(value.helperPid) ||
        value.helperPid < 2 ||
        !Number.isSafeInteger(value.pid) ||
        value.pid < 2 ||
        !Number.isSafeInteger(value.signalNumber) ||
        value.signalNumber < 1 ||
        value.signalNumber > 64
    )
        throw new Error("Invalid nonauthoritative native helper timeout");
    return value;
}

export function recordNativeCoreTimeout(
    { helperPid, pid, signalNumber },
    write = writeFileSync,
) {
    const receipt = validateNativeCoreTimeout({
        version: 2,
        profile: NATIVE_DIAGNOSTIC_PROFILE.RegisteredContext,
        authoritative: false,
        complete: false,
        memoryComplete: false,
        timedOut: true,
        deadlineMs: POLICY.timeoutMs,
        helperPid,
        pid,
        signalNumber,
    });
    try {
        write(path.join(DIRECTORY, POLICY.timeoutArtifact), json(receipt), {
            flag: "wx",
            mode: 0o600,
        });
        return true;
    } catch {
        return false;
    } // Existing timeout/IO failure cannot overwrite first-fault evidence.
}

/** Production entry for the fixed core_pattern; never invoke it on the host. */
export async function runNativeCoreCollector(args) {
    if (args.length !== 2 || !args.every((value) => /^[1-9]\d*$/.test(value)))
        throw new Error("Expected exactly the kernel PID and signal");
    await assertPrivateNativeGuest({ root: ROOT, output: OUTPUT });
    const input = createNativeCoreInput(0);
    // This JS deadline is cooperative; it cannot preempt a native/synchronous
    // hang. The host VM watchdog is the hard backstop, with partial artifacts.
    const timer = setTimeout(() => {
        recordNativeCoreTimeout({
            helperPid: process.pid,
            pid: Number(args[0]),
            signalNumber: Number(args[1]),
        });
        process.exit(124);
    }, POLICY.timeoutMs);
    try {
        const result = await collectNativeCore({
            pid: Number(args[0]),
            signalNumber: Number(args[1]),
            input,
        });
        if (!result.complete) process.exitCode = 1;
        return result;
    } finally {
        clearTimeout(timer);
        input.destroy();
        // autoClose=false is intentional. Release the kernel's retained task
        // only after all /proc reads and the bounded receipt have completed.
        closeSync(0);
    }
}
