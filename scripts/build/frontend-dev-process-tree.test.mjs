import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { signalFrontendDevProcessTree } from "./frontend-dev-process-tree.mjs";
import { projectYarnCommand } from "./project-yarn-command.mjs";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));

test("Windows stops only the owned PID and its descendants through taskkill", () => {
    signalFrontendDevProcessTree(12345, "SIGTERM", {
        platform: "win32",
        windowsRunner(command, args, options) {
            assert.equal(command, "taskkill");
            assert.deepEqual(args, ["/PID", "12345", "/T", "/F"]);
            assert.equal(options.shell, undefined);
            return { status: 0 };
        },
    });
    assert.throws(
        () => signalFrontendDevProcessTree(0, "SIGTERM"),
        /owned child PID/,
    );
});

test(
    "stopping a real project-Yarn child also stops its worker on the host platform",
    { timeout: 15_000 },
    async () => {
        await mkdir(path.join(rootDir, "tmp"), { recursive: true });
        const directory = await mkdtemp(
            path.join(rootDir, "tmp", "frontend-process-tree-"),
        );
        const pidPath = path.join(directory, "pids.json");
        const { command, args } = projectYarnCommand([
            "node",
            "./scripts/build/fixtures/frontend-dev-process-tree.mjs",
        ]);
        const child = spawn(command, args, {
            cwd: rootDir,
            env: {
                ...process.env,
                ARTGOD_FRONTEND_TEST_PID_PATH: pidPath,
                YARN_ENABLE_NETWORK: "0",
                COREPACK_ENABLE_NETWORK: "0",
            },
            stdio: "ignore",
            detached: process.platform !== "win32",
        });
        const exited = new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", resolve);
        });
        let workerPid;
        try {
            const deadline = Date.now() + 8_000;
            while (true) {
                try {
                    workerPid = JSON.parse(
                        await readFile(pidPath, "utf8"),
                    ).workerPid;
                    break;
                } catch (error) {
                    if (error.code !== "ENOENT" || Date.now() > deadline)
                        throw error;
                    await new Promise((resolve) => setTimeout(resolve, 20));
                }
            }
            signalFrontendDevProcessTree(child.pid, "SIGTERM");
            await exited;
            const deadlineAfterStop = Date.now() + 3_000;
            while (processExists(workerPid) && Date.now() < deadlineAfterStop)
                await new Promise((resolve) => setTimeout(resolve, 20));
            assert.equal(
                processExists(workerPid),
                false,
                "The owned worker survived its launcher.",
            );
        } finally {
            for (const pid of [child.pid, workerPid]) {
                if (!pid || !processExists(pid)) continue;
                // Cleanup is confined to this test's known console-only processes.
                try {
                    process.kill(pid, "SIGKILL");
                } catch (error) {
                    if (error.code !== "ESRCH") throw error;
                }
            }
        }
    },
);

function processExists(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (error.code === "ESRCH") return false;
        throw error;
    }
}
