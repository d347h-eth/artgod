import { spawnSync } from "node:child_process";

// The caller owns this child: POSIX wrappers start a separate process group;
// Windows' command interpreter needs an explicit descendant-tree termination.
// Unix signals cannot request graceful termination of a Windows process tree.
export function signalFrontendDevProcessTree(
    pid,
    signal,
    { platform = process.platform, windowsRunner = spawnSync } = {},
) {
    if (!Number.isSafeInteger(pid) || pid < 2)
        throw new Error(
            "Frontend process-tree termination requires an owned child PID.",
        );
    if (platform !== "win32") {
        process.kill(-pid, signal);
        return;
    }
    const result = windowsRunner(
        "taskkill",
        ["/PID", String(pid), "/T", "/F"],
        { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
        // Treat an already-exited child consistently with POSIX ESRCH; do not
        // depend on taskkill's localized text to recognize that race.
        try {
            process.kill(pid, 0);
        } catch (error) {
            if (error.code === "ESRCH") return;
            throw error;
        }
        throw new Error(
            `Frontend process-tree termination failed (${result.status}): ${result.stderr ?? ""}`,
        );
    }
}
