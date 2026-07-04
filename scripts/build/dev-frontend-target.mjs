#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");
const childShutdownGraceMs = 5_000;
const ownerMonitorIntervalMs = 1_000;
const shutdownSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
const forceKillSignal = "SIGKILL";
const ownerLostSignal = "SIGTERM";
const terminatesProcessGroups = process.platform !== "win32";
const sidecarBuildProfileFlag = "--prepare-desktop-sidecars";
const sidecarBuildProfilePrefix = `${sidecarBuildProfileFlag}=`;
const sidecarBuildScript = path.join(
    rootDir,
    "scripts",
    "build",
    "prepare-desktop-sidecars.mjs",
);
const sidecarBuildProfiles = new Set(["debug", "release"]);

const args = process.argv.slice(2);
const rawTarget = resolveRawTarget(args);
const target = normalizeTarget(rawTarget);
const sidecarBuildProfile = resolveSidecarBuildProfile(args);

if (!target) {
    console.error(
        `Unsupported frontend dev target "${rawTarget}". Expected one of: web, userland, admin, desktop.`,
    );
    process.exit(1);
}

const env = {
    ...process.env,
    FRONTEND_BUILD_TARGET: target,
    VITE_FRONTEND_BUILD_TARGET: target,
};

const yarnBin = process.platform === "win32" ? "yarn.cmd" : "yarn";
let activeChild = null;
let activeChildExited = true;
let shutdownStarted = false;
let shutdownSignal = null;
let forceKillTimer = null;
let ownerMonitorTimer = null;
const ownerSnapshot = captureOwnerSnapshot();

for (const signal of shutdownSignals) {
    process.on(signal, () => {
        requestChildShutdown(signal);
    });
}

startOwnerMonitor();
run()
    .then((result) => {
        clearOwnerMonitor();
        if (shutdownSignal) {
            process.exit(resolveSignalExitCode(shutdownSignal));
        }
        if (result.signal) {
            process.exit(resolveSignalExitCode(result.signal));
            return;
        }
        process.exit(result.code ?? 1);
    })
    .catch((error) => {
        clearOwnerMonitor();
        clearForceKillTimer();
        if (shutdownSignal) {
            process.exit(resolveSignalExitCode(shutdownSignal));
        }
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    });

async function run() {
    if (sidecarBuildProfile) {
        await runManagedCommand({
            label: "desktop sidecar preparation",
            command: process.execPath,
            args: [sidecarBuildScript, "--profile", sidecarBuildProfile],
            env: process.env,
            requireSuccess: true,
        });
    }

    return await runManagedCommand({
        label: "frontend dev server",
        command: yarnBin,
        args: ["workspace", "@artgod/frontend", "run", "dev"],
        env,
        requireSuccess: false,
    });
}

function runManagedCommand({ label, command, args, env, requireSuccess }) {
    if (shutdownStarted) {
        return Promise.resolve({
            code: resolveSignalExitCode(shutdownSignal ?? ownerLostSignal),
            signal: shutdownSignal ?? ownerLostSignal,
        });
    }

    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: rootDir,
            env,
            stdio: "inherit",
            detached: terminatesProcessGroups,
        });

        activeChild = child;
        activeChildExited = false;

        child.on("error", (error) => {
            activeChildExited = true;
            if (activeChild === child) {
                activeChild = null;
            }
            reject(
                new Error(
                    `Failed to execute ${label}: ${renderCommand(command, args)}: ${String(error)}`,
                ),
            );
        });

        child.on("exit", (code, signal) => {
            activeChildExited = true;
            if (activeChild === child) {
                activeChild = null;
            }
            clearForceKillTimer();

            const result = { code, signal };
            if (shutdownStarted) {
                resolve(result);
                return;
            }
            if (requireSuccess && (signal || code !== 0)) {
                reject(
                    new Error(
                        `${label} failed via ${renderCommand(command, args)}${
                            signal
                                ? ` with signal ${signal}`
                                : ` with exit code ${code ?? 1}`
                        }`,
                    ),
                );
                return;
            }
            resolve(result);
        });
    });
}

function requestChildShutdown(signal, reason = null) {
    if (shutdownStarted) {
        return;
    }

    shutdownStarted = true;
    shutdownSignal = signal;
    if (reason) {
        console.error(reason);
    }

    // The wrapper owns each dev child process group, including Yarn, Vite, and esbuild.
    signalChildProcessTree(signal);
    forceKillTimer = setTimeout(() => {
        signalChildProcessTree(forceKillSignal);
    }, childShutdownGraceMs);
}

function signalChildProcessTree(signal) {
    if (
        activeChild === null ||
        activeChildExited ||
        activeChild.pid === undefined
    ) {
        return;
    }

    try {
        if (terminatesProcessGroups) {
            process.kill(-activeChild.pid, signal);
        } else {
            activeChild.kill(signal);
        }
    } catch (error) {
        if (!isMissingProcessError(error)) {
            console.error(
                `Failed to send ${signal} to frontend dev process: ${String(error)}`,
            );
        }
    }
}

function clearForceKillTimer() {
    if (forceKillTimer === null) {
        return;
    }
    clearTimeout(forceKillTimer);
    forceKillTimer = null;
}

function startOwnerMonitor() {
    if (!ownerSnapshot) {
        return;
    }
    ownerMonitorTimer = setInterval(() => {
        if (!ownerStillAttached(ownerSnapshot)) {
            requestChildShutdown(
                ownerLostSignal,
                "Frontend dev owner process disappeared; stopping frontend dev server.",
            );
        }
    }, ownerMonitorIntervalMs);
    ownerMonitorTimer.unref?.();
}

function clearOwnerMonitor() {
    if (ownerMonitorTimer === null) {
        return;
    }
    clearInterval(ownerMonitorTimer);
    ownerMonitorTimer = null;
}

function resolveSignalExitCode(signal) {
    const signalNumber = osConstants.signals[signal];
    return signalNumber === undefined ? 1 : 128 + signalNumber;
}

function isMissingProcessError(error) {
    return error && typeof error === "object" && error.code === "ESRCH";
}

function captureOwnerSnapshot() {
    if (process.platform === "win32") {
        return null;
    }
    const parentPid = process.ppid;
    return {
        parentPid,
        parentParentPid: readParentPid(parentPid),
    };
}

function ownerStillAttached(snapshot) {
    if (process.ppid !== snapshot.parentPid) {
        return false;
    }
    if (snapshot.parentParentPid === null) {
        return true;
    }
    return readParentPid(snapshot.parentPid) === snapshot.parentParentPid;
}

function readParentPid(pid) {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const processNameEnd = stat.lastIndexOf(")");
        if (processNameEnd < 0) {
            return null;
        }
        const fields = stat.slice(processNameEnd + 2).split(" ");
        const parentPid = Number(fields[1]);
        return Number.isInteger(parentPid) && parentPid > 0 ? parentPid : null;
    } catch {
        return null;
    }
}

function resolveRawTarget(argv) {
    return argv.find((arg) => !arg.startsWith("--"))?.trim() || "web";
}

function resolveSidecarBuildProfile(argv) {
    const profileValue = argv
        .find((arg) => arg.startsWith(sidecarBuildProfilePrefix))
        ?.slice(sidecarBuildProfilePrefix.length)
        .trim();
    if (!profileValue) {
        return null;
    }
    if (!sidecarBuildProfiles.has(profileValue)) {
        console.error(
            `Unsupported ${sidecarBuildProfileFlag} profile "${profileValue}". Expected one of: debug, release.`,
        );
        process.exit(1);
    }
    return profileValue;
}

function renderCommand(command, args) {
    return [command, ...args].join(" ");
}

function normalizeTarget(rawTarget) {
    if (rawTarget === "desktop") {
        return "admin";
    }
    if (
        rawTarget === "web" ||
        rawTarget === "userland" ||
        rawTarget === "admin"
    ) {
        return rawTarget;
    }
    return null;
}
