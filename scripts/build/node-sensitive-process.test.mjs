import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
);
const packageManifestPath = path.join(rootDir, "package.json");
const childReadyTimeoutMs = 10_000;
const postSignalInspectionDelayMs = 500;
// Owns the test-only IPC vocabulary shared with the inline Node child.
const NODE_CHILD_MESSAGE_KIND = Object.freeze({
    inspect: "inspect",
    inspection: "inspection",
    ready: "ready",
    shutdown: "shutdown",
});
const childSource = `
    import inspector from "node:inspector";

    process.on("message", (message) => {
        if (message?.kind === ${JSON.stringify(NODE_CHILD_MESSAGE_KIND.inspect)}) {
            process.send?.({ kind: ${JSON.stringify(NODE_CHILD_MESSAGE_KIND.inspection)}, url: inspector.url() ?? null });
            return;
        }
        if (message?.kind === ${JSON.stringify(NODE_CHILD_MESSAGE_KIND.shutdown)}) {
            process.exit(0);
        }
    });
    process.send?.({ kind: ${JSON.stringify(NODE_CHILD_MESSAGE_KIND.ready)} });
    setInterval(() => {}, 1_000);
`;

// This boundary proof intentionally spells the Node CLI value Rust must own.
const NODE_DISABLE_SIGNAL_INSPECTOR_ARG = "--disable-sigusr1";

test(
    "keeps the pinned Node process alive without an inspector after SIGUSR1",
    {
        skip:
            process.platform === "win32"
                ? "SIGUSR1 is available only on Unix platforms."
                : false,
    },
    async (context) => {
        const packageManifest = JSON.parse(
            await readFile(packageManifestPath, "utf8"),
        );
        assert.equal(process.versions.node, packageManifest.engines.node);

        const child = spawn(
            process.execPath,
            [
                NODE_DISABLE_SIGNAL_INSPECTOR_ARG,
                "--input-type=module",
                "--eval",
                childSource,
            ],
            { stdio: ["ignore", "ignore", "pipe", "ipc"] },
        );
        context.after(() => {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill("SIGKILL");
            }
        });

        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });

        const [ready] = await once(child, "message", {
            signal: AbortSignal.timeout(childReadyTimeoutMs),
        });
        assert.equal(ready?.kind, NODE_CHILD_MESSAGE_KIND.ready);
        assert.equal(child.kill("SIGUSR1"), true);
        await delay(postSignalInspectionDelayMs);
        assert.equal(
            child.exitCode,
            null,
            `Node exited after SIGUSR1: ${stderr}`,
        );

        const inspectionMessage = once(child, "message", {
            signal: AbortSignal.timeout(childReadyTimeoutMs),
        });
        child.send({ kind: NODE_CHILD_MESSAGE_KIND.inspect });
        const [inspection] = await inspectionMessage;
        assert.equal(inspection?.kind, NODE_CHILD_MESSAGE_KIND.inspection);
        assert.equal(inspection.url, null);
        assert.doesNotMatch(stderr, /Debugger listening on/i);

        const exitEvent = once(child, "exit", {
            signal: AbortSignal.timeout(childReadyTimeoutMs),
        });
        child.send({ kind: NODE_CHILD_MESSAGE_KIND.shutdown });
        const [code, signal] = await exitEvent;
        assert.equal(signal, null);
        assert.equal(code, 0, stderr);
    },
);
