import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Match desktop bundling while retaining the host's existing native SQLite binding.
export async function buildIndexerTestWorker({ entryPoint, outfile }) {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    if (!path.resolve(outfile).startsWith(path.join(root, "tmp") + path.sep))
        throw new Error("Indexer fixture output must be inside worktree tmp");
    if (
        !path
            .resolve(root, entryPoint)
            .startsWith(path.join(root, "indexer/tests/fixtures") + path.sep)
    )
        throw new Error(
            "Indexer child entry must be a maintained test fixture",
        );
    await build({
        absWorkingDir: root,
        entryPoints: [entryPoint],
        outfile,
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node24",
        external: ["better-sqlite3"],
        banner: {
            js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
        },
        logLevel: "warning",
    });
}
