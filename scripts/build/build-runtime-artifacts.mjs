#!/usr/bin/env node
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");
const legacyOutDir = path.join(rootDir, "dist-desktop", "runtime");
const backendOutDir = path.join(rootDir, "backend", "dist-desktop");
const indexerOutDir = path.join(rootDir, "indexer", "dist-desktop");
const tradingOutDir = path.join(rootDir, "trading", "dist-desktop");

await rm(legacyOutDir, { recursive: true, force: true });
await rm(backendOutDir, { recursive: true, force: true });
await rm(indexerOutDir, { recursive: true, force: true });
await rm(tradingOutDir, { recursive: true, force: true });
await mkdir(backendOutDir, { recursive: true });
await mkdir(indexerOutDir, { recursive: true });
await mkdir(tradingOutDir, { recursive: true });

const baseBuildConfig = {
    absWorkingDir: rootDir,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    sourcemap: false,
    minify: false,
    external: ["better-sqlite3"],
    banner: {
        js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
    },
    legalComments: "none",
    logLevel: "info",
    // Keep runtime builds isolated from the repository-level project references
    // (especially frontend/.svelte-kit) so clean builds stay warning-free.
    tsconfigRaw: {
        compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "bundler",
            resolveJsonModule: true,
            esModuleInterop: true,
            allowSyntheticDefaultImports: true,
            isolatedModules: true,
        },
    },
};

await build({
    ...baseBuildConfig,
    entryPoints: {
        server: path.join(rootDir, "backend", "src", "index.ts"),
    },
    outdir: backendOutDir,
});

await build({
    ...baseBuildConfig,
    entryPoints: {
        "scheduler-worker": path.join(
            rootDir,
            "indexer",
            "src",
            "runtime",
            "scheduler-worker.ts",
        ),
        "sync-worker": path.join(
            rootDir,
            "indexer",
            "src",
            "runtime",
            "sync-worker.ts",
        ),
        "reorg-worker": path.join(
            rootDir,
            "indexer",
            "src",
            "runtime",
            "reorg-worker.ts",
        ),
        "domain-worker": path.join(
            rootDir,
            "indexer",
            "src",
            "runtime",
            "domain-worker.ts",
        ),
        "offchain-ingest-worker": path.join(
            rootDir,
            "indexer",
            "src",
            "runtime",
            "offchain-ingest-worker.ts",
        ),
        "opensea-stream-worker": path.join(
            rootDir,
            "indexer",
            "src",
            "runtime",
            "opensea-stream-worker.ts",
        ),
        "opensea-bootstrap-worker": path.join(
            rootDir,
            "indexer",
            "src",
            "runtime",
            "opensea-bootstrap-worker.ts",
        ),
        "opensea-reconcile-worker": path.join(
            rootDir,
            "indexer",
            "src",
            "runtime",
            "opensea-reconcile-worker.ts",
        ),
        "opensea-reconcile-scheduler-worker": path.join(
            rootDir,
            "indexer",
            "src",
            "runtime",
            "opensea-reconcile-scheduler-worker.ts",
        ),
        "bootstrap-worker": path.join(
            rootDir,
            "indexer",
            "src",
            "runtime",
            "bootstrap-worker.ts",
        ),
        "collection-extension-worker": path.join(
            rootDir,
            "indexer",
            "src",
            "runtime",
            "collection-extension-worker.ts",
        ),
        "dead-letter-worker": path.join(
            rootDir,
            "indexer",
            "src",
            "runtime",
            "dead-letter-worker.ts",
        ),
    },
    outdir: indexerOutDir,
});

await build({
    ...baseBuildConfig,
    entryPoints: {
        "bidding-bot-runtime": path.join(
            rootDir,
            "trading",
            "src",
            "runtime",
            "bidding-bot-runtime.ts",
        ),
        "sniping-bot-runtime": path.join(
            rootDir,
            "trading",
            "src",
            "runtime",
            "sniping-bot-runtime.ts",
        ),
    },
    outdir: tradingOutDir,
});
