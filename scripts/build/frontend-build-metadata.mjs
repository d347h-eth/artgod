import { execFileSync } from "node:child_process";

/**
 * Read the actual checkout HEAD, including linked worktrees. Admin builds must
 * identify their source; web builds from source archives may omit Git metadata.
 * @param {string} rootDir
 * @param {{ required: boolean }} options
 */
export function readFrontendBuildCommit(rootDir, { required }) {
    try {
        const commit = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
            cwd: rootDir,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        }).trim();
        if (!/^[a-f0-9]{40}$/.test(commit)) {
            throw new Error("Git HEAD did not resolve to a full commit hash");
        }
        return commit;
    } catch (cause) {
        if (required) {
            throw new Error(
                "Admin frontend build requires a Git checkout with a committed HEAD to identify the app revision.",
                { cause },
            );
        }
        return "";
    }
}
