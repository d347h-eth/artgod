#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");

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
});

child.on("error", (error) => {
    console.error(
        `Failed to execute "${yarnBin} workspace @artgod/frontend run dev": ${String(error)}`,
    );
    process.exit(1);
});

child.on("exit", (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
        return;
    }
    process.exit(code ?? 1);
});

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
