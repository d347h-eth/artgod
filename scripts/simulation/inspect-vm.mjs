#!/usr/bin/env node
import { createConnection } from "node:net";
import path from "node:path";
import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { assertWorktreeTemporaryPath } from "./artifacts.mjs";

/** Read-only guest-machine diagnostics; never controls the host display or input. */
export async function inspectVm(directory, mode = "record") {
    if (!["record", "replay"].includes(mode))
        throw new Error("Unknown execution mode");
    const target = await assertWorktreeTemporaryPath(directory);
    // A directory FD avoids the Unix socket path limit even in long worktree paths.
    const directoryHandle = await open(target, "r");
    try {
        return await new Promise((resolve, reject) => {
            const socket = createConnection(
                `/proc/self/fd/${directoryHandle.fd}/${mode}-monitor.sock`,
            );
            let pending = "";
            let state = "greeting";
            let settled = false;
            const output = [];
            const commands = [
                { execute: "query-status" },
                {
                    execute: "human-monitor-command",
                    arguments: { "command-line": "info registers" },
                },
                {
                    execute: "human-monitor-command",
                    arguments: { "command-line": "info block" },
                },
                { execute: "query-blockstats" },
                {
                    execute: "human-monitor-command",
                    arguments: { "command-line": "info replay" },
                },
                {
                    execute: "human-monitor-command",
                    arguments: { "command-line": "info irq" },
                },
            ];
            const timer = setTimeout(
                () =>
                    socket.destroy(new Error("Guest monitor did not respond")),
                5000,
            );
            socket.on("error", (error) => {
                clearTimeout(timer);
                settled = true;
                reject(error);
            });
            socket.once("close", () => {
                clearTimeout(timer);
                if (!settled)
                    reject(
                        new Error(
                            "Guest monitor closed before diagnostics completed",
                        ),
                    );
            });
            socket.on("data", (bytes) => {
                pending += bytes.toString();
                if (pending.length > 1024 * 1024) {
                    socket.destroy(
                        new Error(
                            "Guest monitor response exceeds the diagnostic limit",
                        ),
                    );
                    return;
                }
                while (pending.includes("\n")) {
                    const end = pending.indexOf("\n");
                    const line = pending.slice(0, end);
                    pending = pending.slice(end + 1);
                    let message;
                    try {
                        message = JSON.parse(line);
                    } catch {
                        socket.destroy(new Error("Malformed QMP response"));
                        return;
                    }
                    if (state === "greeting") {
                        state = "capabilities";
                        socket.write(
                            `${JSON.stringify({ execute: "qmp_capabilities" })}\n`,
                        );
                    } else if (!("event" in message)) {
                        if (state !== "capabilities") output.push(message);
                        const next = commands.shift();
                        if (!next) {
                            clearTimeout(timer);
                            settled = true;
                            socket.end();
                            resolve(output);
                            return;
                        }
                        state = "query";
                        socket.write(`${JSON.stringify(next)}\n`);
                    }
                }
            });
        });
    } finally {
        await directoryHandle.close();
    }
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
    if (process.argv.length < 3 || process.argv.length > 4) {
        console.error(
            "Usage: node scripts/simulation/inspect-vm.mjs <run-directory> [record|replay]",
        );
        process.exitCode = 1;
    } else
        inspectVm(process.argv[2], process.argv[3])
            .then((result) => console.log(JSON.stringify(result, null, 2)))
            .catch((error) => {
                console.error(error.message);
                process.exitCode = 1;
            });
}
