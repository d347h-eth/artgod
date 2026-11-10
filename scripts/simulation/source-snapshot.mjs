import { lstat, readlink } from "node:fs/promises";
import path from "node:path";
import { pinFile } from "./artifacts.mjs";
import { executeCommand } from "./qemu-replay.mjs";

// Include untracked source as well as tracked changes. Generated payloads are
// inventoried separately: a parent commit alone never identifies a dirty build.
const SOURCE_PATHS = Object.freeze([
    "package.json",
    "yarn.lock",
    ".yarnrc.yml",
    ".yarn/patches",
    "backend/src",
    "backend/package.json",
    "backend/tsconfig.json",
    "indexer/src",
    "indexer/package.json",
    "indexer/tsconfig.json",
    "trading/src",
    "trading/package.json",
    "trading/tsconfig.json",
    "shared",
    "database/migrations",
    "config",
    "scripts/build",
    "scripts/simulation",
    "tsconfig.json",
    "tsconfig.base.json",
]);

/** Capture source membership and bytes at each compilation boundary. */
export async function snapshotSource(
    rootDir,
    { execute = executeCommand } = {},
) {
    const git = async (args) => {
        const result = await execute("git", args, {
            cwd: rootDir,
            env: process.env,
            timeoutMs: 30_000,
        });
        if (
            result.code !== 0 ||
            result.signal ||
            result.timedOut ||
            result.outputLimit
        )
            throw new Error(
                "Cannot capture simulation build source provenance",
            );
        return result.stdout;
    };
    const sourceCommit = (await git(["rev-parse", "HEAD"])).trim();
    const names = [
        ...new Set(
            (
                await git([
                    "ls-files",
                    "-z",
                    "--cached",
                    "--others",
                    "--exclude-standard",
                    "--",
                    ...SOURCE_PATHS,
                ])
            )
                .split("\0")
                .filter(Boolean),
        ),
    ].sort();
    const files = [];
    for (const name of names) {
        const filename = path.resolve(rootDir, name);
        const metadata = await lstat(filename).catch((error) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
        });
        // A tracked deletion is still represented by changed membership.
        if (!metadata) continue;
        if (metadata.isSymbolicLink())
            files.push({ path: name, symlink: await readlink(filename) });
        else if (metadata.isFile())
            files.push(await pinFile(filename, rootDir));
        else throw new Error(`Unexpected build source type: ${name}`);
    }
    return { sourceCommit, files };
}

/** Refuse attributing compiled output to source that changed during compilation. */
export function assertSameSource(before, after) {
    if (JSON.stringify(before) !== JSON.stringify(after))
        throw new Error(
            "Simulation build sources changed during compilation; rerun after edits settle",
        );
}
