import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (process.argv[2] === "worker") {
    setInterval(() => {}, 1_000);
} else {
    const pidPath = process.env.ARTGOD_FRONTEND_TEST_PID_PATH;
    if (!pidPath) throw new Error("ARTGOD_FRONTEND_TEST_PID_PATH is required.");
    const worker = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), "worker"],
        { stdio: "ignore" },
    );
    worker.once("spawn", () =>
        writeFileSync(
            pidPath,
            JSON.stringify({ parentPid: process.pid, workerPid: worker.pid }),
        ),
    );
    // Reap the fixture worker before exiting on POSIX. Windows taskkill stops
    // the complete tree; there are no servers, ports or native app processes.
    process.on("SIGTERM", () => worker.once("exit", () => process.exit(0)));
}
