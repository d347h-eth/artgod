#!/usr/bin/env node
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    assertIpv4WildcardPortIsFree,
    DESKTOP_IPV4_LOOPBACK_HOST,
} from "./desktop-listener-contract.mjs";
const NATS_PORTS_FILE_SUFFIX = ".ports";
const NATS_LISTENER_START_TIMEOUT_MS = 10_000;
const NATS_LISTENER_POLL_INTERVAL_MS = 50;
const NATS_SHUTDOWN_TIMEOUT_MS = 5_000;
const SOCKET_CONNECT_TIMEOUT_MS = 2_000;
const MAX_DIAGNOSTIC_OUTPUT_LENGTH = 32_768;

// Exercises the staged NATS executable and proves its client socket is IPv4-loopback-only.
export async function verifyStagedDesktopNatsLoopbackBinding({
    natsBinaryPath,
}) {
    await assertRegularFile(natsBinaryPath, "bundled NATS binary");

    const temporaryRoot = await mkdtemp(
        path.join(os.tmpdir(), "artgod-nats-loopback-"),
    );
    const portsDirectory = path.join(temporaryRoot, "ports");
    const storeDirectory = path.join(temporaryRoot, "store");
    await mkdir(portsDirectory, { recursive: true });
    await mkdir(storeDirectory, { recursive: true });

    let diagnosticOutput = "";
    let child;
    let childCompletion;
    let childStartError;

    try {
        child = spawn(
            natsBinaryPath,
            [
                "--addr",
                DESKTOP_IPV4_LOOPBACK_HOST,
                "--port",
                "-1",
                "--ports_file_dir",
                portsDirectory,
                "--jetstream",
                "--store_dir",
                storeDirectory,
            ],
            {
                cwd: temporaryRoot,
                env: process.env,
                stdio: ["ignore", "pipe", "pipe"],
            },
        );
        child.once("error", (error) => {
            childStartError = error;
        });
        child.stdout?.on("data", (chunk) => {
            diagnosticOutput = appendDiagnosticOutput(diagnosticOutput, chunk);
        });
        child.stderr?.on("data", (chunk) => {
            diagnosticOutput = appendDiagnosticOutput(diagnosticOutput, chunk);
        });
        childCompletion = new Promise((resolve) => {
            child.once("close", (code, signal) => resolve({ code, signal }));
        });

        const portsFilePath = await waitForNatsPortsFile({
            child,
            getChildStartError: () => childStartError,
            portsDirectory,
        });
        const listener = await readNatsClientListener(portsFilePath);
        if (listener.hostname !== DESKTOP_IPV4_LOOPBACK_HOST) {
            throw new Error(
                `Bundled NATS reported client listener host ${listener.hostname}; expected ${DESKTOP_IPV4_LOOPBACK_HOST}.`,
            );
        }

        const listenerPort = parseListenerPort(listener);
        await assertTcpConnects(DESKTOP_IPV4_LOOPBACK_HOST, listenerPort);
        await assertIpv4WildcardPortIsFree({
            listenerName: "Bundled NATS",
            expectedHost: DESKTOP_IPV4_LOOPBACK_HOST,
            port: listenerPort,
        });
    } catch (error) {
        const diagnostics = diagnosticOutput.trim();
        throw new Error(
            diagnostics
                ? `${String(error)}\nBundled NATS output:\n${diagnostics}`
                : String(error),
            { cause: error },
        );
    } finally {
        if (child && childCompletion) {
            await terminateChild(child, childCompletion);
        }
        await rm(temporaryRoot, { recursive: true, force: true });
    }
}

async function assertRegularFile(filePath, description) {
    let metadata;
    try {
        metadata = await lstat(filePath);
    } catch (error) {
        throw new Error(`${description} is unavailable: ${filePath}. ${error}`);
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error(`${description} is not a regular file: ${filePath}`);
    }
}

async function waitForNatsPortsFile({
    child,
    getChildStartError,
    portsDirectory,
}) {
    const deadline = Date.now() + NATS_LISTENER_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const startError = getChildStartError();
        if (startError) {
            throw new Error(
                `Unable to start bundled NATS: ${String(startError)}`,
            );
        }
        if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(
                `Bundled NATS exited before publishing its listener contract (code ${String(child.exitCode)}, signal ${String(child.signalCode)}).`,
            );
        }

        const portsFiles = (await readdir(portsDirectory)).filter((entry) =>
            entry.endsWith(NATS_PORTS_FILE_SUFFIX),
        );
        if (portsFiles.length > 1) {
            throw new Error(
                `Bundled NATS published multiple listener contract files: ${portsFiles.join(", ")}.`,
            );
        }
        if (portsFiles.length === 1) {
            return path.join(portsDirectory, portsFiles[0]);
        }
        await delay(NATS_LISTENER_POLL_INTERVAL_MS);
    }
    throw new Error(
        `Bundled NATS did not publish its listener contract within ${NATS_LISTENER_START_TIMEOUT_MS}ms.`,
    );
}

async function readNatsClientListener(portsFilePath) {
    const source = await readFile(portsFilePath, "utf8");
    let payload;
    try {
        payload = JSON.parse(source);
    } catch (error) {
        throw new Error(
            `Bundled NATS listener contract is invalid JSON: ${String(error)}`,
        );
    }
    if (!Array.isArray(payload.nats) || payload.nats.length !== 1) {
        throw new Error(
            "Bundled NATS listener contract must report exactly one client listener.",
        );
    }
    const listener = new URL(payload.nats[0]);
    if (listener.protocol !== "nats:") {
        throw new Error(
            `Bundled NATS listener contract uses unexpected protocol ${listener.protocol}.`,
        );
    }
    return listener;
}

function parseListenerPort(listener) {
    const port = Number.parseInt(listener.port, 10);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new Error(
            `Bundled NATS listener contract uses invalid port ${listener.port}.`,
        );
    }
    return port;
}

async function assertTcpConnects(host, port) {
    await new Promise((resolve, reject) => {
        const socket = createConnection({ host, port });
        socket.setTimeout(SOCKET_CONNECT_TIMEOUT_MS);
        socket.once("connect", () => {
            socket.destroy();
            resolve();
        });
        socket.once("timeout", () => {
            socket.destroy();
            reject(
                new Error(
                    `Timed out connecting to bundled NATS at ${host}:${port}.`,
                ),
            );
        });
        socket.once("error", (error) => {
            reject(
                new Error(
                    `Unable to connect to bundled NATS at ${host}:${port}: ${String(error)}`,
                ),
            );
        });
    });
}

async function terminateChild(child, childCompletion) {
    if (child.exitCode !== null || child.signalCode !== null) {
        await childCompletion;
        return;
    }
    child.kill("SIGTERM");
    const stopped = await waitForChildCompletion(
        childCompletion,
        NATS_SHUTDOWN_TIMEOUT_MS,
    );
    if (!stopped) {
        child.kill("SIGKILL");
        await childCompletion;
    }
}

async function waitForChildCompletion(childCompletion, timeoutMilliseconds) {
    let timeoutHandle;
    try {
        return await Promise.race([
            childCompletion.then(() => true),
            new Promise((resolve) => {
                timeoutHandle = setTimeout(
                    () => resolve(false),
                    timeoutMilliseconds,
                );
            }),
        ]);
    } finally {
        clearTimeout(timeoutHandle);
    }
}

function appendDiagnosticOutput(current, chunk) {
    return `${current}${String(chunk)}`.slice(-MAX_DIAGNOSTIC_OUTPUT_LENGTH);
}

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const invokedScriptPath = process.argv[1]
    ? path.resolve(process.argv[1])
    : undefined;
if (
    invokedScriptPath &&
    import.meta.url === pathToFileURL(invokedScriptPath).href
) {
    const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
    const rootDir = path.resolve(scriptDirectory, "../..");
    const natsBinaryPath = path.join(
        rootDir,
        "src-tauri",
        "resources",
        "runtime",
        "nats",
        process.platform === "win32" ? "nats-server.exe" : "nats-server",
    );
    await verifyStagedDesktopNatsLoopbackBinding({ natsBinaryPath });
    console.log("Verified staged desktop NATS IPv4-loopback binding.");
}
