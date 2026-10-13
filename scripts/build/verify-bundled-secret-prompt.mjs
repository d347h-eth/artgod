import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
// Production CLI request that reaches owner-loss handling without opening prompt UI.
const secretPromptStartupArguments = Object.freeze(["--action", "unlock"]);
// Owner loss is the helper's silent failure result when its parent input is closed.
const secretPromptOwnerLossExitCode = 1;
const secretPromptStartupTimeoutMilliseconds = 5_000;

// Starts the final prompt helper and closes input before any native UI can open.
export async function verifySecretPromptStartup(filePath, options = {}) {
    const processRunner = options.processRunner ?? runSilentProcess;
    const logger = options.logger ?? console.log;
    const result = await processRunner(filePath, secretPromptStartupArguments, {
        timeoutMilliseconds: secretPromptStartupTimeoutMilliseconds,
    });

    if (result.signal !== null) {
        throw new Error(
            `Secret prompt startup smoke terminated with signal ${String(result.signal)}.`,
        );
    }
    if (result.exitCode !== secretPromptOwnerLossExitCode) {
        throw new Error(
            `Secret prompt startup smoke exited with code ${String(result.exitCode)}; expected ${secretPromptOwnerLossExitCode}.`,
        );
    }
    if (result.stdoutProduced || result.stderrProduced) {
        throw new Error(
            "Secret prompt startup smoke produced unexpected process output.",
        );
    }

    logger(
        `Started bundled secret prompt without opening native UI: ${filePath}`,
    );
}

async function runSilentProcess(command, args, { timeoutMilliseconds }) {
    return await new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: rootDir,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdoutProduced = false;
        let stderrProduced = false;
        let timedOut = false;
        let settled = false;

        child.stdout?.on("data", (chunk) => {
            stdoutProduced ||= chunk.length > 0;
        });
        child.stderr?.on("data", (chunk) => {
            stderrProduced ||= chunk.length > 0;
        });

        const timeoutHandle = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, timeoutMilliseconds);

        child.once("error", (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutHandle);
            reject(error);
        });
        child.once("close", (exitCode, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutHandle);
            if (timedOut) {
                reject(
                    new Error(
                        `Secret prompt startup smoke exceeded ${timeoutMilliseconds}ms.`,
                    ),
                );
                return;
            }
            resolve({
                exitCode,
                signal,
                stdoutProduced,
                stderrProduced,
            });
        });
    });
}
