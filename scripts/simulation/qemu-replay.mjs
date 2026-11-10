#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertPinnedInputBytesContract } from "../build/pinned-build-inputs.mjs";
import {
    hashFile as digest,
    pinFile,
    createArtifactRunDirectory,
} from "./artifacts.mjs";
import {
    QUALIFICATION_PROTOCOL_PREFIX,
    QUALIFICATION_PROTOCOL_VERSION,
    QUALIFICATION_EVENT,
    QUALIFICATION_STATUS,
    QUALIFICATION_CHECKS,
} from "./qualification-protocol.mjs";

import { compareGuestDisks } from "./image-artifacts.mjs";
import { storageProfile, SCENARIO_DEVICE_ENV } from "./storage-profile.mjs";
import { cpuModel, CPU_MODEL } from "./cpu-model.mjs";
import { captureArtifactJson } from "./run-evidence.mjs";

export const QUALIFICATION_PROTOCOL = QUALIFICATION_PROTOCOL_PREFIX;
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PIN_NAMES = [
    "qemu",
    "qemuImg",
    "firmware",
    "kernel",
    "guest",
    "scenario",
];
const KERNEL_ARGUMENTS =
    "root=/dev/vda rw console=ttyS0 earlycon=uart8250,io,0x3f8,115200n8 init=/workbench/init panic=1";
export const QEMU_ENVIRONMENT = Object.freeze({
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
});
export const EXECUTION_INTERRUPTED_CODE = "ARTGOD_SIMULATION_INTERRUPTED";

/** Cleanup wrappers retain causes; interruption must still stop outer schedulers. */
export function isExecutionInterrupted(error) {
    const seen = new Set();
    const visit = (value) => {
        if (!value || typeof value !== "object" || seen.has(value))
            return false;
        seen.add(value);
        return (
            value.code === EXECUTION_INTERRUPTED_CODE ||
            visit(value.cause) ||
            (Array.isArray(value.errors) && value.errors.some(visit))
        );
    };
    return visit(error);
}
const ENVIRONMENT = QEMU_ENVIRONMENT;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const GUEST_MEMORY_MIB = 2048;

function objectKeys(value, expected, label) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${label} must be an object`);
    const actual = Object.keys(value).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...expected].sort()))
        throw new Error(`${label} requires exactly: ${expected.join(", ")}`);
}

/** No arbitrary QEMU options, host mounts or implicit tool/image discovery. */
export function validateManifest(value, manifestPath) {
    const pins = [
        ...PIN_NAMES,
        ...(value && typeof value === "object" && "toolCapsule" in value
            ? ["toolCapsule"]
            : []),
    ];
    objectKeys(
        value,
        [
            "version",
            "sourceSha",
            "qualificationId",
            "expectedChecks",
            "machine",
            "epoch",
            "timeoutSeconds",
            ...pins,
            ...(value && typeof value === "object" && "storageProfile" in value
                ? ["storageProfile"]
                : []),
            ...(value && typeof value === "object" && "cpu" in value
                ? ["cpu"]
                : []),
        ],
        "Manifest",
    );
    if (value.version !== 1) throw new Error("Unsupported manifest version");
    if ("storageProfile" in value) storageProfile(value.storageProfile);
    if ("cpu" in value) cpuModel(value.cpu);
    if (!/^[a-f0-9]{40}$/.test(value.sourceSha ?? ""))
        throw new Error("sourceSha must be an explicit full source commit SHA");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value.qualificationId ?? ""))
        throw new Error("qualificationId must be a short stable identifier");
    if (
        !Array.isArray(value.expectedChecks) ||
        !value.expectedChecks.length ||
        value.expectedChecks.length > 32 ||
        value.expectedChecks.some(
            (check) =>
                typeof check !== "string" ||
                !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(check),
        ) ||
        new Set(value.expectedChecks).size !== value.expectedChecks.length
    )
        throw new Error(
            "expectedChecks must contain distinct explicit identifiers",
        );
    // This baseline fixes the i440fx platform; alias machines are not pins.
    if (!/^pc-i440fx-\d+\.\d+$/.test(value.machine ?? ""))
        throw new Error(
            "machine must be an explicit versioned pc-i440fx machine",
        );
    if (
        typeof value.epoch !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value.epoch) ||
        !Number.isFinite(Date.parse(value.epoch)) ||
        new Date(value.epoch).toISOString().replace(".000Z", "Z") !==
            value.epoch
    )
        throw new Error("epoch must be an exact UTC timestamp");
    if (
        !Number.isInteger(value.timeoutSeconds) ||
        value.timeoutSeconds < 1 ||
        value.timeoutSeconds > 3600
    )
        throw new Error("timeoutSeconds must be between 1 and 3600");
    const result = { ...value, expectedChecks: [...value.expectedChecks] };
    for (const name of pins) {
        const pin = value[name];
        objectKeys(
            pin,
            [
                "path",
                "sha256",
                "sizeBytes",
                ...(["qemu", "qemuImg"].includes(name) ? ["version"] : []),
            ],
            name,
        );
        if (
            typeof pin.path !== "string" ||
            !pin.path.trim() ||
            /[\x00-\x1f]/.test(pin.path)
        )
            throw new Error(`${name}.path is required`);
        assertPinnedInputBytesContract({
            ...pin,
            fileName: path.basename(pin.path),
        });
        if (
            "version" in pin &&
            (typeof pin.version !== "string" ||
                !pin.version.trim() ||
                /[\r\n]/.test(pin.version))
        )
            throw new Error(
                `${name}.version must be the exact first version-output line`,
            );
        result[name] = {
            ...pin,
            path: path.resolve(path.dirname(manifestPath), pin.path),
        };
    }
    if (new Set(pins.map((name) => result[name].path)).size !== pins.length)
        throw new Error("Each pinned input must have a distinct path");
    return result;
}

async function assertPins(manifest) {
    for (const name of [
        ...PIN_NAMES,
        ...(manifest.toolCapsule ? ["toolCapsule"] : []),
    ]) {
        const pin = manifest[name];
        const metadata = await stat(pin.path).catch((error) => {
            throw new Error(`Cannot read ${name}: ${error.message}`);
        });
        if (
            !metadata.isFile() ||
            metadata.size !== pin.sizeBytes ||
            (await digest(pin.path)) !== pin.sha256
        )
            throw new Error(
                `Pinned ${name} size/SHA-256 changed or is not a file`,
            );
    }
}

export function assertStandaloneImage(info) {
    if (
        !info ||
        info.format !== "qcow2" ||
        !Number.isSafeInteger(info["virtual-size"]) ||
        info["virtual-size"] <= 0
    )
        throw new Error("Guest must be a standalone qcow2 image");
    const inspect = (value) => {
        if (!value || typeof value !== "object") return;
        for (const [key, item] of Object.entries(value)) {
            if (
                [
                    "backing-filename",
                    "full-backing-filename",
                    "data-file",
                    "full-data-file",
                ].includes(key) &&
                item
            )
                throw new Error(
                    "Guest image cannot reference backing or external data files",
                );
            if (
                (["encrypted", "corrupt", "dirty-flag"].includes(key) &&
                    item === true) ||
                (key === "encrypt" && item)
            )
                throw new Error(
                    "Guest image cannot be encrypted, corrupt or dirty",
                );
            inspect(item);
        }
    };
    inspect(info);
}

async function successful(execute, file, args, options = {}) {
    const result = await execute(file, args, {
        timeoutMs: 15_000,
        env: ENVIRONMENT,
        ...options,
    });
    if (
        result.timedOut ||
        result.outputLimit ||
        result.code !== 0 ||
        result.signal
    )
        throw new Error(
            `${path.basename(file)} failed (${result.timedOut ? "timeout" : result.outputLimit ? "output limit" : (result.signal ?? result.code)})`,
        );
    return result;
}
export { successful as executeSuccessfulCommand };

/** Read-only admission: validate every input before creating a run directory. */
export async function preflight(
    manifestPath,
    { execute = executeCommand } = {},
) {
    const absolute = path.resolve(manifestPath);
    const captured = await captureArtifactJson(absolute);
    const manifestSha256 = captured.pin.sha256;
    const admitted = await preflightManifest(captured.value, absolute, {
        execute,
    });
    if ((await digest(absolute)) !== manifestSha256)
        throw new Error("Manifest changed during preflight");
    return { ...admitted, manifestSha256 };
}

/** Admit candidate inputs before publishing any runnable manifest file. */
export async function preflightManifest(
    value,
    manifestPath,
    { execute = executeCommand } = {},
) {
    const absolute = path.resolve(manifestPath);
    const manifest = validateManifest(value, absolute);
    await assertPins(manifest);
    const capsuleExecution = manifest.toolCapsule
        ? await (
              await import("./tool-capsule.mjs")
          ).createToolCapsuleExecution({
              filename: manifest.toolCapsule.path,
              manifest,
              execute,
          })
        : undefined;
    const engineExecute = capsuleExecution?.execute ?? execute;
    for (const name of ["qemu", "qemuImg"]) {
        const result = await successful(engineExecute, manifest[name].path, [
            "--version",
        ]);
        if (result.stdout.split(/\r?\n/, 1)[0] !== manifest[name].version)
            throw new Error(`Pinned ${name} version output does not match`);
    }
    const machines = await successful(engineExecute, manifest.qemu.path, [
        "-machine",
        "help",
    ]);
    if (
        !machines.stdout
            .split(/\r?\n/)
            .some((line) => line.trim().split(/\s+/, 1)[0] === manifest.machine)
    )
        throw new Error(`Pinned QEMU does not provide ${manifest.machine}`);
    const image = await successful(engineExecute, manifest.qemuImg.path, [
        "info",
        "--output=json",
        manifest.guest.path,
    ]);
    assertStandaloneImage(JSON.parse(image.stdout));
    await assertPins(manifest);
    return {
        manifest,
        manifestPath: absolute,
        execute: engineExecute,
        ...(capsuleExecution
            ? { toolImageAdmission: capsuleExecution.identity }
            : {}),
    };
}

export function qemuArguments(manifest, overlay, replayLog, mode) {
    if (!["record", "replay"].includes(mode))
        throw new Error("Unknown replay mode");
    const storage =
        "storageProfile" in manifest
            ? storageProfile(manifest.storageProfile)
            : undefined;
    const kernelArguments = storage
        ? [
              KERNEL_ARGUMENTS.replace(
                  "root=/dev/vda",
                  `root=${storage.rootDevice}`,
              ),
              ...storage.kernelOptions,
              `${SCENARIO_DEVICE_ENV}=${storage.scenarioDevice}`,
          ].join(" ")
        : KERNEL_ARGUMENTS;
    // Replay's documented drive stack creates BlockBackends for both the image
    // and replay filter; comma escaping preserves literal filenames in QemuOpts.
    return [
        "-no-user-config",
        "-nodefaults",
        "-machine",
        manifest.machine,
        "-accel",
        "tcg,thread=single",
        "-cpu",
        // Legacy recordings omit cpu and must retain their exact old arguments.
        "cpu" in manifest ? cpuModel(manifest.cpu) : CPU_MODEL.Nehalem,
        "-smp",
        "1",
        "-m",
        String(GUEST_MEMORY_MIB),
        "-bios",
        manifest.firmware.path,
        "-kernel",
        manifest.kernel.path,
        "-append",
        kernelArguments,
        "-display",
        "none",
        "-monitor",
        "none",
        "-qmp",
        `unix:${mode}-monitor.sock,server=on,wait=off`,
        "-serial",
        "stdio",
        "-parallel",
        "none",
        "-nic",
        "none",
        "-no-reboot",
        "-rtc",
        `base=${manifest.epoch.slice(0, -1)},clock=vm`,
        "-icount",
        `shift=0,align=off,sleep=on,rr=${mode},rrfile=${replayLog.replaceAll(",", ",,")}`,
        "-drive",
        `file=${overlay.replaceAll(",", ",,")},format=qcow2,if=none,id=image`,
        "-drive",
        "driver=blkreplay,if=none,image=image,id=replay-disk",
        "-device",
        storage?.rootController ??
            "virtio-blk-pci,drive=replay-disk,ioeventfd=off",
        "-drive",
        `file=${manifest.scenario.path.replaceAll(",", ",,")},format=raw,if=none,readonly=on,id=scenario`,
        "-drive",
        "driver=blkreplay,if=none,image=scenario,id=scenario-replay,readonly=on",
        "-device",
        "virtio-blk-pci,drive=scenario-replay,ioeventfd=off",
    ];
}

export async function assertGuestProtocol(serialPath, manifest) {
    let phase = "initial";
    let completion;
    const lines = createInterface({
        input: createReadStream(serialPath),
        crlfDelay: Infinity,
    });
    try {
        for await (const line of lines) {
            if (!line.startsWith(QUALIFICATION_PROTOCOL)) continue;
            const message = JSON.parse(
                line.slice(QUALIFICATION_PROTOCOL.length),
            );
            const ready = message.event === QUALIFICATION_EVENT.Ready;
            objectKeys(
                message,
                [
                    "version",
                    "qualificationId",
                    "event",
                    ...(ready ? [] : ["status", "checks"]),
                ],
                "Guest protocol",
            );
            if (
                message.version !== QUALIFICATION_PROTOCOL_VERSION ||
                message.qualificationId !== manifest.qualificationId
            )
                throw new Error(
                    "Guest qualification protocol identity/version mismatch",
                );
            if (ready && phase === "initial") phase = "ready";
            else if (
                message.event === QUALIFICATION_EVENT.Complete &&
                phase === "ready"
            ) {
                objectKeys(
                    message.checks,
                    manifest.expectedChecks,
                    "Guest checks",
                );
                if (
                    Object.values(message.checks).some(
                        (passed) => typeof passed !== "boolean",
                    )
                )
                    throw new Error("Guest check results must be booleans");
                const expectedStatus = Object.values(message.checks).every(
                    Boolean,
                )
                    ? QUALIFICATION_STATUS.Passed
                    : QUALIFICATION_STATUS.Failed;
                if (message.status !== expectedStatus)
                    throw new Error(
                        "Guest completion status disagrees with its check results",
                    );
                completion = { status: message.status, checks: message.checks };
                phase = "complete";
            } else
                throw new Error(
                    "Guest protocol has duplicate or out-of-order events",
                );
        }
    } finally {
        lines.close();
    }
    if (phase !== "complete")
        throw new Error("Guest did not complete the qualification protocol");
    return completion;
}

/** A completed run qualifies replay of this guest/input environment only. */
export async function qualify(
    manifestPath,
    {
        execute = executeCommand,
        outputRoot = path.join(ROOT, "tmp", "simulation-qemu"),
    } = {},
) {
    const startedAt = performance.now();
    const admitted = await preflight(manifestPath, { execute });
    const { manifest } = admitted;
    const engineExecute = admitted.execute;
    const directory = await createArtifactRunDirectory(outputRoot);
    const replayLog = path.join(directory, "replay.bin");
    const report = {
        version: 1,
        sourceSha: manifest.sourceSha,
        qualificationId: manifest.qualificationId,
        status: "failed",
        engineReplayStatus: "unqualified",
        guestDiskParityStatus: "not-run",
        propertyStatus: "unqualified",
        substrateQualificationStatus: "not-run",
        evidence: "whole-machine-record-replay",
        manifestSha256: admitted.manifestSha256,
        ...(admitted.toolImageAdmission
            ? { toolImageAdmission: admitted.toolImageAdmission }
            : {}),
        directory,
        metrics: {
            phases: [],
            configuredGuestMemoryMiB: GUEST_MEMORY_MIB,
            maxSimultaneousGuestsInPair: 1,
        },
    };
    const assertUnchanged = async () => {
        if ((await digest(admitted.manifestPath)) !== admitted.manifestSha256)
            throw new Error("Manifest changed after admission");
        await assertPins(manifest);
    };
    try {
        const completions = {};
        await writeFile(
            path.join(directory, "input-manifest.json"),
            JSON.stringify(manifest, null, 2),
        );
        report.inputManifestSha256 = await digest(
            path.join(directory, "input-manifest.json"),
        );
        for (const mode of ["record", "replay"]) {
            await assertUnchanged();
            const overlay = path.join(directory, `${mode}.qcow2`);
            await successful(
                engineExecute,
                manifest.qemuImg.path,
                [
                    "create",
                    "-f",
                    "qcow2",
                    "-F",
                    "qcow2",
                    "-b",
                    manifest.guest.path,
                    overlay,
                ],
                { cwd: directory },
            );
            const args = qemuArguments(manifest, overlay, replayLog, mode);
            await writeFile(
                path.join(directory, `${mode}-command.json`),
                JSON.stringify(
                    { file: manifest.qemu.path, args, env: ENVIRONMENT },
                    null,
                    2,
                ),
            );
            const stdoutPath = path.join(directory, `${mode}-serial.log`);
            const phaseStartedAt = performance.now();
            const phase = { mode };
            report.metrics.phases.push(phase);
            try {
                await successful(engineExecute, manifest.qemu.path, args, {
                    cwd: directory,
                    timeoutMs: manifest.timeoutSeconds * 1000,
                    stdoutPath,
                    stderrPath: path.join(directory, `${mode}-qemu.log`),
                });
            } finally {
                phase.hostElapsedMs = Math.round(
                    performance.now() - phaseStartedAt,
                );
                for (const [key, filename] of Object.entries({
                    serialBytes: stdoutPath,
                    overlayBytes: overlay,
                    eventLogBytes: replayLog,
                })) {
                    const metadata = await stat(filename).catch(
                        () => undefined,
                    );
                    if (metadata) phase[key] = metadata.size;
                }
            }
            if (!(await stat(stdoutPath)).size)
                throw new Error(`${mode} serial output is empty`);
            completions[mode] = await assertGuestProtocol(stdoutPath, manifest);
            if (!(await stat(replayLog)).size)
                throw new Error("Replay log is empty");
            if (mode === "record")
                report.replayLogSha256 = await digest(replayLog);
            else if ((await digest(replayLog)) !== report.replayLogSha256)
                throw new Error("Replay modified its recorded event log");
            await assertUnchanged();
        }
        report.serialSha256 = await digest(
            path.join(directory, "record-serial.log"),
        );
        if (
            report.serialSha256 !==
            (await digest(path.join(directory, "replay-serial.log")))
        )
            throw new Error("Record/replay serial bytes differ");
        // Guest output can omit state. Compare visible disk bytes after both
        // machines close; qcow2 allocation/metadata differences are immaterial.
        report.guestDiskParityStatus = "failed";
        await compareGuestDisks({
            run: (args, options) =>
                successful(engineExecute, manifest.qemuImg.path, args, options),
            first: path.join(directory, "record.qcow2"),
            second: path.join(directory, "replay.qcow2"),
            guestPath: manifest.guest.path,
            cwd: directory,
        });
        report.guestDiskParityStatus = "passed";
        report.recordOverlay = await pinFile(
            path.join(directory, "record.qcow2"),
            directory,
        );
        await assertUnchanged();
        report.engineReplayStatus = "passed";
        report.propertyStatus = completions.record.status;
        report.status = report.propertyStatus;
        report.guestReportedChecks = completions.record.checks;
        if (
            JSON.stringify([...manifest.expectedChecks].sort()) ===
            JSON.stringify([...QUALIFICATION_CHECKS].sort())
        )
            report.substrateQualificationStatus = report.propertyStatus;
        report.limitations = [
            manifest.toolCapsule
                ? "QEMU userspace is pinned by the retained OCI capsule; the host kernel remains external"
                : "Host QEMU shared libraries/kernel are not fully pinned",
            "Guest assertions require separate review",
            "No claim of unexplored schedules or ArtGod correctness",
        ];
        return report;
    } catch (error) {
        report.engineReplayStatus = "failed";
        if (isExecutionInterrupted(error))
            report.errorCode = EXECUTION_INTERRUPTED_CODE;
        report.error = error.message;
        const failure = new Error(
            `${error.message}; retained artifacts: ${directory}`,
            {
                cause: error,
            },
        );
        failure.report = report;
        failure.directory = directory;
        if (report.errorCode) failure.code = report.errorCode;
        throw failure;
    } finally {
        report.metrics.hostElapsedMs = Math.round(
            performance.now() - startedAt,
        );
        await writeFile(
            path.join(directory, "report.json"),
            JSON.stringify(report, null, 2),
        );
    }
}

// Raw serial parity needs bounded byte-preserving capture. The shared redacting
// runner buffers text and is deliberately not used for these synthetic VM logs.
export async function executeCommand(file, args, options = {}) {
    return await new Promise((resolve, reject) => {
        const child = spawn(file, args, {
            cwd: options.cwd,
            env: options.env ?? ENVIRONMENT,
            stdio: ["ignore", "pipe", "pipe"],
            detached: true,
        });
        const outputs = [options.stdoutPath, options.stderrPath].map(
            (target) =>
                target ? createWriteStream(target, { flags: "wx" }) : null,
        );
        const pending = [[], []];
        const sizes = [0, 0];
        let timedOut = false;
        let outputLimit = false;
        let failure;
        let forceTimer;
        const kill = (signal) => {
            try {
                process.kill(-child.pid, signal);
            } catch (error) {
                if (error.code !== "ESRCH") failure ??= error;
            }
        };
        const stop = () => {
            kill("SIGTERM");
            forceTimer ??= setTimeout(() => kill("SIGKILL"), 1000);
        };
        const interrupt = (signal) => {
            failure ??= Object.assign(
                new Error(`Execution interrupted by ${signal}`),
                { code: EXECUTION_INTERRUPTED_CODE, signal },
            );
            stop();
        };
        const onSigint = () => interrupt("SIGINT");
        const onSigterm = () => interrupt("SIGTERM");
        const timer = setTimeout(() => {
            timedOut = true;
            stop();
        }, options.timeoutMs ?? 15_000);
        process.once("SIGINT", onSigint);
        process.once("SIGTERM", onSigterm);
        [child.stdout, child.stderr].forEach((source, index) => {
            outputs[index]?.on("error", (error) => {
                failure ??= error;
                stop();
            });
            source.on("data", (data) => {
                sizes[index] += data.length;
                if (
                    sizes[index] >
                    (outputs[index] ? MAX_OUTPUT_BYTES : 1024 * 1024)
                ) {
                    outputLimit = true;
                    stop();
                    return;
                }
                if (outputs[index]) {
                    if (!outputs[index].write(data)) {
                        source.pause();
                        outputs[index].once("drain", () => source.resume());
                    }
                } else pending[index].push(data);
            });
        });
        child.once("error", (error) => {
            failure ??= error;
        });
        child.once("close", async (code, signal) => {
            clearTimeout(timer);
            clearTimeout(forceTimer);
            process.removeListener("SIGINT", onSigint);
            process.removeListener("SIGTERM", onSigterm);
            try {
                await Promise.all(
                    outputs.filter(Boolean).map((output) => {
                        output.end();
                        return finished(output);
                    }),
                );
                if (failure) reject(failure);
                else
                    resolve({
                        code,
                        signal,
                        timedOut,
                        outputLimit,
                        stdout: Buffer.concat(pending[0]).toString("utf8"),
                        stderr: Buffer.concat(pending[1]).toString("utf8"),
                    });
            } catch (error) {
                reject(error);
            }
        });
    });
}

async function main(args) {
    if (
        ![2, 3].includes(args.length) ||
        args[0] !== "--manifest" ||
        (args[2] && args[2] !== "--run")
    )
        throw new Error(
            "Usage: node scripts/simulation/qemu-replay.mjs --manifest INPUT.json [--run]",
        );
    const result =
        args[2] === "--run" ? await qualify(args[1]) : await preflight(args[1]);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (args[2] === "--run" && result.status !== "passed") process.exitCode = 1;
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
    main(process.argv.slice(2)).catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
