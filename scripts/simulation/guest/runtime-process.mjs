import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isRuntimeReadyLog } from "../../../shared/runtime/readiness.ts";
import {
    SIMULATION_EVIDENCE_PREFIX,
    SIMULATION_EVIDENCE_EVENT,
} from "../qualification-protocol.mjs";

export const RUNTIME_PROCESS_EXIT_CODE = "ARTGOD_SIMULATION_RUNTIME_EXIT";
export const RUNTIME_PROCESS_PROPERTY = Object.freeze({
    Liveness: "production-runtime-liveness",
});

/** An observed process exit, not an inference from a later diagnostic snapshot. */
export class RuntimeProcessExit extends Error {
    constructor({ actorId, pid, exitCode = null, signal = null }) {
        super(
            `Production ${actorId} exited (${exitCode ?? signal}); inspect its retained logs`,
        );
        this.name = "RuntimeProcessExit";
        this.code = RUNTIME_PROCESS_EXIT_CODE;
        this.property = RUNTIME_PROCESS_PROPERTY.Liveness;
        this.actorId = actorId;
        this.pid = pid;
        this.exitCode = exitCode;
        this.signal = signal;
    }
}

export function findRuntimeProcessExit(error) {
    const seen = new Set();
    while (error && typeof error === "object" && !seen.has(error)) {
        seen.add(error);
        if (error instanceof RuntimeProcessExit) return error;
        error = error.cause;
    }
}

export async function launchRuntime(
    spec,
    { root, output, env, eventually, nativeDiagnostics },
) {
    assert.ok(
        spec.readyMessage,
        "The selected production runtime needs its owning readiness label",
    );
    const stem = spec.generation
        ? `${spec.id}.restart-${spec.generation}`
        : spec.id;
    const stdoutPath = path.join(output, `${stem}.stdout.log`);
    const stderrPath = path.join(output, `${stem}.stderr.log`);
    const stdout = await open(stdoutPath, "w");
    const stderr = await open(stderrPath, "w");
    const command = nativeDiagnostics?.launchCommand(spec, process.execPath, [
        spec.filename,
    ]) ?? { file: process.execPath, args: [spec.filename] };
    const child = spawn(command.file, command.args, {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
    });
    let ready = false;
    const decoder = new StringDecoder("utf8");
    let pendingLine = "";
    let failure;
    child.once("error", (error) => {
        failure = error;
    });
    child.stdout.on("data", (chunk) => {
        // Observing logs does not replace any production readiness or business work.
        pendingLine = (pendingLine + decoder.write(chunk)).slice(-65_536);
        const lines = pendingLine.split("\n");
        pendingLine = lines.pop();
        if (lines.some((line) => isRuntimeReadyLog(line, spec.readyMessage)))
            ready = true;
        void stdout.write(chunk).catch((error) => {
            failure = error;
        });
    });
    child.stderr.on("data", (chunk) => {
        void stderr.write(chunk).catch((error) => {
            failure = error;
        });
    });
    child.once("close", () => {
        void stdout.close();
        void stderr.close();
    });
    const assertAlive = () => {
        if (failure) throw failure;
        if (child.exitCode !== null || child.signalCode !== null)
            throw new RuntimeProcessExit({
                actorId: spec.id,
                pid: child.pid,
                exitCode: child.exitCode,
                signal: child.signalCode,
            });
    };
    try {
        await nativeDiagnostics?.track(spec, child);
        await eventually(
            () => {
                assertAlive();
                return ready;
            },
            `${spec.id} entrypoint ready`,
            90_000,
        );
        await nativeDiagnostics?.verifyRuntime(spec, child);
    } catch (error) {
        child.kill("SIGKILL");
        throw error;
    }
    process.stdout.write(
        `${SIMULATION_EVIDENCE_PREFIX}${JSON.stringify({ [SIMULATION_EVIDENCE_EVENT.ProcessReady]: { id: spec.id, generation: spec.generation ?? 0, pid: child.pid } })}\n`,
    );
    return { ...spec, child, assertAlive, stdoutPath, stderrPath };
}
