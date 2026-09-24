import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Bundle the maintained child fixture like the desktop worker; keep native SQLite external.
export async function buildOrderQueueTestWorker(outfile) {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    if (!path.resolve(outfile).startsWith(path.join(root, "tmp") + path.sep)) {
        throw new Error(
            "Order queue fixture output must be inside worktree tmp",
        );
    }
    await build({
        absWorkingDir: root,
        entryPoints: ["indexer/tests/fixtures/maker-queue-worker.ts"],
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
