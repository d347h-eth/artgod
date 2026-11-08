import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

/** Stream large images and logs without allocating their full contents. */
export async function hashFile(filename) {
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(filename)) hash.update(bytes);
    return hash.digest("hex");
}

export async function pinFile(filename, relativeBase) {
    const metadata = await stat(filename);
    if (!metadata.isFile())
        throw new Error("Pinned artifact must be a regular file");
    return {
        path: relativeBase
            ? path.relative(relativeBase, filename)
            : path.resolve(filename),
        sizeBytes: metadata.size,
        sha256: await hashFile(filename),
    };
}

/** Validate lexical and existing-parent paths before creating temporary outputs. */
export async function assertWorktreeTemporaryPath(filename) {
    if (
        typeof filename !== "string" ||
        !filename ||
        /[\x00-\x1f]/.test(filename)
    )
        throw new Error("An explicit worktree tmp path is required");
    const absolute = path.resolve(filename);
    const tmp = path.join(ROOT, "tmp");
    const relative = path.relative(tmp, absolute);
    if (
        !relative ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
    )
        throw new Error(
            "Artifact outputs must stay inside the worktree tmp directory",
        );
    let ancestor = absolute;
    while (true) {
        try {
            await lstat(ancestor);
            break;
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
            ancestor = path.dirname(ancestor);
        }
    }
    const actual = await realpath(ancestor);
    const workspace = await realpath(ROOT);
    const canonicalTmp = path.join(workspace, "tmp");
    if (
        ancestor === ROOT
            ? actual !== workspace
            : actual !== canonicalTmp &&
              !actual.startsWith(`${canonicalTmp}${path.sep}`)
    )
        throw new Error(
            "Artifact output symlink escapes the worktree tmp directory",
        );
    return absolute;
}

export async function createArtifactRunDirectory(parent, prefix = "run-") {
    const directory = await assertWorktreeTemporaryPath(parent);
    await mkdir(directory, { recursive: true });
    await assertWorktreeTemporaryPath(directory);
    return await mkdtemp(path.join(directory, prefix));
}
