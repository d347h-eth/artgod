#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");

const target = process.argv[2]?.trim() || "web";
if (target !== "web" && target !== "desktop") {
    console.error(
        `Unsupported frontend build target "${target}". Expected "web" or "desktop".`,
    );
    process.exit(1);
}

const env = {
    ...process.env,
    FRONTEND_BUILD_TARGET: target,
    VITE_FRONTEND_BUILD_TARGET: target,
};

const yarnBin = process.platform === "win32" ? "yarn.cmd" : "yarn";
runCommand(yarnBin, ["workspace", "@artgod/frontend", "run", "build"], {
    cwd: rootDir,
    env,
})
    .then(async () => {
        if (target === "desktop") {
            const nodeBin = process.platform === "win32" ? "node.exe" : "node";
            await runCommand(
                nodeBin,
                [path.join(__dirname, "export-tauri-frontend.mjs")],
                {
                    cwd: rootDir,
                    env,
                },
            );
        }
        process.exit(0);
    })
    .catch((error) => {
        console.error(String(error));
        process.exit(1);
    });

function runCommand(command, args, options) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: "inherit",
            ...options,
        });
        child.on("error", (error) => {
            reject(
                new Error(
                    `Failed to execute "${command} ${args.join(" ")}": ${String(error)}`,
                ),
            );
        });
        child.on("exit", (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(
                new Error(
                    `Command "${command} ${args.join(" ")}" exited with code ${code ?? "unknown"}`,
                ),
            );
        });
    });
}
