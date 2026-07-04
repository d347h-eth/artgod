#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");
const childShutdownGraceMs = 5_000;
const shutdownSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
const forceKillSignal = "SIGKILL";
const terminatesProcessGroups = process.platform !== "win32";

const rawTarget = process.argv[2]?.trim() || "web";
const target = normalizeTarget(rawTarget);

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
const child = spawn(yarnBin, ["workspace", "@artgod/frontend", "run", "dev"], {
    cwd: rootDir,
    env,
    stdio: "inherit",
    detached: terminatesProcessGroups,
});
let childExited = false;
let shutdownStarted = false;
let shutdownSignal = null;
let forceKillTimer = null;

child.on("error", (error) => {
    console.error(
        `Failed to execute "${yarnBin} workspace @artgod/frontend run dev": ${String(error)}`,
    );
    process.exit(1);
});

child.on("exit", (code, signal) => {
    childExited = true;
    clearForceKillTimer();

    if (shutdownSignal) {
        process.exit(resolveSignalExitCode(shutdownSignal));
    }
    if (signal) {
        process.exit(resolveSignalExitCode(signal));
        return;
    }
    process.exit(code ?? 1);
});

for (const signal of shutdownSignals) {
    process.on(signal, () => {
        requestChildShutdown(signal);
    });
}

function requestChildShutdown(signal) {
    if (shutdownStarted) {
        return;
    }

    shutdownStarted = true;
    shutdownSignal = signal;

    // Tauri owns this wrapper; the wrapper owns the whole Yarn/Vite child group.
    signalChildProcessTree(signal);
    forceKillTimer = setTimeout(() => {
        signalChildProcessTree(forceKillSignal);
    }, childShutdownGraceMs);
}

function signalChildProcessTree(signal) {
    if (childExited || child.pid === undefined) {
        return;
    }

    try {
        if (terminatesProcessGroups) {
            process.kill(-child.pid, signal);
        } else {
            child.kill(signal);
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

function resolveSignalExitCode(signal) {
    const signalNumber = osConstants.signals[signal];
    return signalNumber === undefined ? 1 : 128 + signalNumber;
}

function isMissingProcessError(error) {
    return error && typeof error === "object" && error.code === "ESRCH";
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
