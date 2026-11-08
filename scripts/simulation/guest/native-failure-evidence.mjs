import { execFile } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import * as filesystem from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { RUNTIME_PROCESS } from "./runtime-manifest.mjs";
import { parseElfCoreNotes, ELF_CORE_LIMITS } from "./elf-core-notes.mjs";

export const NATIVE_FAILURE_ARTIFACT = "native-failure.json";
export const NATIVE_DIAGNOSTIC_PROFILE = Object.freeze({
    BoundedCore: "bounded-core-v1",
});
export const NATIVE_DIAGNOSTIC_CHECK = "guest-native-core-capture";
export const NATIVE_DIAGNOSTIC_ACTOR = Object.freeze({
    Probe: "native-core-probe",
});
export const NATIVE_CORE_POLICY = Object.freeze({
    bytes: ELF_CORE_LIMITS.bytes,
    filter: "00000010",
    pattern: "/workbench/output/native-core/core.%p.%s",
    executable: "/usr/bin/prlimit",
    artifact: "native-core.json",
    directory: "native-core",
});
export const NATIVE_FAILURE_POLICY = Object.freeze({
    timeoutMs: 2_000,
    kernelBytes: 65_536,
    procBytes: 8_192,
    errorBytes: 1_024,
});

const EXECUTABLE = "/bin/busybox";
const FILES = Object.freeze({
    CorePattern: "/proc/sys/kernel/core_pattern",
    CoreUsesPid: "/proc/sys/kernel/core_uses_pid",
});

function boundedText(value, maximumBytes) {
    const bytes = Buffer.isBuffer(value)
        ? value
        : Buffer.from(String(value ?? ""), "utf8");
    return {
        // Leave an incomplete trailing UTF-8 sequence buffered rather than
        // expanding it into replacement characters beyond the byte ceiling.
        text: new StringDecoder("utf8").write(bytes.subarray(0, maximumBytes)),
        truncated: bytes.length > maximumBytes,
    };
}

/** Read private guest kernel/proc evidence; never enable cores or mutate sysctls.
 * Node's execFile owns timeout, output bounds and child termination. Importing
 * the host QEMU executable here would also import its controller signal policy.
 */
export async function captureGuestNativeFailure({
    executeFile = execFile,
    diagnostics,
} = {}) {
    const capture = (args, maximumBytes) =>
        new Promise((resolve) => {
            const complete = (error, stdout, stderr) => {
                const out = boundedText(stdout, maximumBytes);
                const err = boundedText(stderr, maximumBytes);
                const outputLimit =
                    error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
                    out.truncated ||
                    err.truncated;
                resolve({
                    executable: EXECUTABLE,
                    args,
                    code: error
                        ? typeof error.code === "number"
                            ? error.code
                            : null
                        : 0,
                    signal: error?.signal ?? null,
                    timedOut: error?.killed === true && !outputLimit,
                    outputLimit,
                    stdout: out.text,
                    stderr: err.text,
                    ...(error
                        ? {
                              error: {
                                  code: error.code ?? null,
                                  message: boundedText(
                                      error.message,
                                      NATIVE_FAILURE_POLICY.errorBytes,
                                  ).text,
                              },
                          }
                        : {}),
                });
            };
            try {
                executeFile(
                    EXECUTABLE,
                    args,
                    {
                        encoding: "utf8",
                        timeout: NATIVE_FAILURE_POLICY.timeoutMs,
                        maxBuffer: maximumBytes,
                        killSignal: "SIGKILL",
                    },
                    complete,
                );
            } catch (error) {
                complete(error, "", "");
            }
        });
    const limitsPath = `/proc/${process.pid}/limits`;
    const [kernelRing, corePattern, coreUsesPid, resourceLimits] =
        await Promise.all([
            // SYSLOG_ACTION_READ_ALL returns the most recent bounded ring data.
            // No -c/-C option: observing the ring must not consume or clear it.
            capture(
                ["dmesg", "-s", String(NATIVE_FAILURE_POLICY.kernelBytes)],
                NATIVE_FAILURE_POLICY.kernelBytes,
            ),
            capture(
                ["cat", FILES.CorePattern],
                NATIVE_FAILURE_POLICY.procBytes,
            ),
            capture(
                ["cat", FILES.CoreUsesPid],
                NATIVE_FAILURE_POLICY.procBytes,
            ),
            // Read the coordinator's own limits, rather than the cat child's.
            capture(["cat", limitsPath], NATIVE_FAILURE_POLICY.procBytes),
        ]);
    return {
        version: 1,
        kernelRing,
        corePattern,
        coreUsesPid,
        resourceLimits: { pid: process.pid, ...resourceLimits },
        ...(diagnostics ? { coreCapture: await diagnostics.capture() } : {}),
    };
}

/** One opt-in profile, no arbitrary kernel paths, actors, limits or launch arguments. */
export function validateNativeDiagnostics(value) {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).join(",") !== "profile" ||
        value.profile !== NATIVE_DIAGNOSTIC_PROFILE.BoundedCore
    )
        throw new Error(
            "nativeDiagnostics requires exactly the supported bounded core profile",
        );
    return { profile: value.profile };
}

export function nativeCoreLimitCommand(executable, args) {
    return {
        file: NATIVE_CORE_POLICY.executable,
        args: [
            `--core=${NATIVE_CORE_POLICY.bytes}:${NATIVE_CORE_POLICY.bytes}`,
            "--",
            executable,
            ...args,
        ],
    };
}

/** Decode Linux's effective byte limits, rather than assuming shell units. */
export function assertNativeCoreLimits(limits, filter) {
    const line = limits
        .split("\n")
        .find((value) => value.startsWith("Max core file size"));
    const match = line?.match(
        /^Max core file size\s+(\d+)\s+(\d+)\s+bytes\s*$/,
    );
    if (
        !match ||
        Number(match[1]) !== NATIVE_CORE_POLICY.bytes ||
        Number(match[2]) !== NATIVE_CORE_POLICY.bytes ||
        filter.trim().toLowerCase() !== NATIVE_CORE_POLICY.filter
    )
        throw new Error(
            "The guest actor did not retain the exact bounded core policy",
        );
    return {
        coreSoftBytes: Number(match[1]),
        coreHardBytes: Number(match[2]),
        coredumpFilter: filter.trim(),
    };
}

/** Mutates only the admitted private guest. Never call host sysctl/prlimit. */
export async function prepareNativeDiagnostics({
    settings,
    root,
    output,
    actorId = RUNTIME_PROCESS.Domain,
    io = filesystem,
}) {
    validateNativeDiagnostics(settings);
    if (
        root !== "/workbench" ||
        output !== "/workbench/output" ||
        (await io.readlink("/proc/1/exe")) !==
            (await io.realpath("/bin/busybox"))
    )
        throw new Error(
            "Native capture may run only inside the private replay guest",
        );
    if (
        ![RUNTIME_PROCESS.Domain, NATIVE_DIAGNOSTIC_ACTOR.Probe].includes(
            actorId,
        )
    )
        throw new Error("Unsupported native diagnostic actor");
    const tool = await io.lstat(NATIVE_CORE_POLICY.executable);
    if (!tool.isFile() || tool.size < 1 || tool.size > 2 * 1024 * 1024)
        throw new Error(
            "The admitted guest prlimit executable is missing or invalid",
        );
    const directory = path.join(output, NATIVE_CORE_POLICY.directory);
    await io.mkdir(directory, { mode: 0o700 });
    const original = {
        corePattern: (
            await io.readFile("/proc/sys/kernel/core_pattern", "utf8")
        ).trim(),
        coredumpFilter: (
            await io.readFile("/proc/self/coredump_filter", "utf8")
        ).trim(),
    };
    await io.writeFile(
        "/proc/sys/kernel/core_pattern",
        NATIVE_CORE_POLICY.pattern,
    );
    await io.writeFile("/proc/self/coredump_filter", "0x10");
    const effective = {
        corePattern: (
            await io.readFile("/proc/sys/kernel/core_pattern", "utf8")
        ).trim(),
        coordinatorFilter: (
            await io.readFile("/proc/self/coredump_filter", "utf8")
        ).trim(),
    };
    if (
        effective.corePattern !== NATIVE_CORE_POLICY.pattern ||
        effective.coordinatorFilter !== NATIVE_CORE_POLICY.filter
    )
        throw new Error(
            "Guest core policy read-back differs from the requested profile",
        );
    const toolBytes = await io.readFile(NATIVE_CORE_POLICY.executable);
    if (toolBytes.length !== tool.size)
        throw new Error("Guest prlimit bytes changed during policy admission");
    const receipt = {
        version: 1,
        profile: settings.profile,
        requested: {
            coreBytes: NATIVE_CORE_POLICY.bytes,
            coredumpFilter: NATIVE_CORE_POLICY.filter,
            corePattern: NATIVE_CORE_POLICY.pattern,
            actorId,
        },
        original,
        effective,
        tool: {
            path: NATIVE_CORE_POLICY.executable,
            sizeBytes: tool.size,
            sha256: createHash("sha256").update(toolBytes).digest("hex"),
        },
        cores: [],
    };
    let target;
    const persist = () =>
        io.writeFile(
            path.join(output, NATIVE_CORE_POLICY.artifact),
            `${JSON.stringify(receipt, null, 2)}\n`,
        );
    await persist();
    const selected = (spec) =>
        spec.id === actorId && (spec.generation ?? 0) === 0;
    return {
        launchCommand(spec, executable, args) {
            if (!selected(spec)) return { file: executable, args };
            if (target)
                throw new Error(
                    "The diagnostic profile permits one actor generation only",
                );
            return nativeCoreLimitCommand(executable, args);
        },
        track(spec, child) {
            if (!selected(spec)) return;
            if (target || !Number.isSafeInteger(child.pid) || child.pid < 2)
                throw new Error(
                    "One real diagnostic child identity is required",
                );
            target = { spec, child };
            effective.actor = {
                id: spec.id,
                generation: 0,
                pid: child.pid,
                filename: spec.filename,
            };
        },
        async verifyRuntime(spec, child) {
            if (!selected(spec)) return;
            if (!target || target.child !== child)
                throw new Error("Diagnostic actor identity changed");
            const prefix = `/proc/${child.pid}`;
            const [limits, filter, executable, command] = await Promise.all([
                io.readFile(`${prefix}/limits`, "utf8"),
                io.readFile(`${prefix}/coredump_filter`, "utf8"),
                io.readlink(`${prefix}/exe`),
                io.readFile(`${prefix}/cmdline`),
            ]);
            const argv = command.toString("utf8").split("\0").filter(Boolean);
            if (
                executable !== process.execPath ||
                argv.length !== 2 ||
                argv[0] !== process.execPath ||
                argv[1] !== spec.filename
            )
                throw new Error(
                    "Native diagnostic actor changed its real Node executable or argv",
                );
            Object.assign(
                effective.actor,
                assertNativeCoreLimits(limits, filter),
                { exe: executable, argv },
            );
            await persist();
        },
        async verifyProbeReceipt({ limits, filter, pid, filename }) {
            if (
                actorId !== NATIVE_DIAGNOSTIC_ACTOR.Probe ||
                target?.child.pid !== pid ||
                target.spec.filename !== filename
            )
                throw new Error("Synthetic native probe identity changed");
            Object.assign(
                effective.actor,
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
            receipt.cores = [];
            const expected =
                !!target?.child.signalCode &&
                [
                    "SIGSEGV",
                    "SIGBUS",
                    "SIGILL",
                    "SIGABRT",
                    "SIGFPE",
                    "SIGTRAP",
                    "SIGSYS",
                    "SIGQUIT",
                ].includes(target.child.signalCode);
            receipt.coreExpected = expected;
            try {
                const files = await io.readdir(directory);
                if (files.length > 1)
                    throw new Error(
                        "Diagnostic core count exceeds the one-actor limit",
                    );
                for (const file of files) {
                    const match = file.match(/^core\.(\d+)\.(\d+)$/);
                    if (
                        !match ||
                        Number(match[1]) !== target?.child.pid ||
                        !Number.isSafeInteger(Number(match[2])) ||
                        Number(match[2]) < 1 ||
                        Number(match[2]) > 64
                    )
                        throw new Error("Unexpected diagnostic core identity");
                    const filename = path.join(directory, file),
                        metadata = await io.lstat(filename);
                    if (
                        !metadata.isFile() ||
                        metadata.size < 1 ||
                        metadata.size > NATIVE_CORE_POLICY.bytes
                    )
                        throw new Error(
                            "Expected a bounded regular guest core",
                        );
                    const bytes = await io.readFile(filename);
                    if (bytes.length !== metadata.size)
                        throw new Error("Guest core changed while being read");
                    const item = {
                        file: `${NATIVE_CORE_POLICY.directory}/${file}`,
                        pid: Number(match[1]),
                        signalNumber: Number(match[2]),
                        sizeBytes: bytes.length,
                        sha256: createHash("sha256")
                            .update(bytes)
                            .digest("hex"),
                        capReached: bytes.length === NATIVE_CORE_POLICY.bytes,
                        notesComplete: false,
                    };
                    try {
                        const notes = parseElfCoreNotes(bytes);
                        Object.assign(item, {
                            notesComplete: notes.notesComplete,
                            missingNotes: notes.missingNotes,
                            signal: notes.signal,
                            crashingThread: notes.crashingThread,
                            threadSelection: notes.threadSelection,
                            threadCount: notes.threads.length,
                            fileCount: notes.files.length,
                            executable: notes.executable,
                            fileMapping: notes.fileMapping,
                            loadSegmentsComplete: notes.loadSegmentsComplete,
                        });
                    } catch (error) {
                        item.error = error.message;
                    }
                    receipt.cores.push(item);
                }
                receipt.missing = expected && !receipt.cores.length;
            } catch (error) {
                receipt.error = error.message;
                receipt.missing = expected && !receipt.cores.length;
            }
            await persist().catch((error) => {
                receipt.artifactError = error.message;
            });
            return structuredClone(receipt);
        },
    };
}
