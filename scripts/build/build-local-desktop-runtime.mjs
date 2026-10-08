#!/usr/bin/env node
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { localRuntimeBuildOptions } from "./local-desktop-runtime-options.mjs";
import { RUNTIME_ARTIFACT } from "./runtime-build-profile.mjs";
import {
    localDesktopPaths,
    LOCAL_PROFILE,
    LOCAL_PROFILE_MARKER,
    validateLocalRuntimeMetafile,
} from "./local-desktop-contract.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");
const { artifacts } = localDesktopPaths(rootDir);
const backendOutDir = path.join(artifacts, "backend");
const indexerOutDir = path.join(artifacts, "indexer");
const tradingOutDir = path.join(artifacts, "trading");

await rm(backendOutDir, { recursive: true, force: true });
await rm(indexerOutDir, { recursive: true, force: true });
await rm(tradingOutDir, { recursive: true, force: true });
await mkdir(backendOutDir, { recursive: true });
await mkdir(indexerOutDir, { recursive: true });
await mkdir(tradingOutDir, { recursive: true });

const baseBuildConfig = localRuntimeBuildOptions(rootDir);

const backendBuildResult = await build({
    ...baseBuildConfig,
    entryPoints: {
        server: path.join(rootDir, "backend", "src", "index.ts"),
    },
    outdir: backendOutDir,
});
validateLocalRuntimeMetafile(
    RUNTIME_ARTIFACT.Backend,
    backendBuildResult.metafile,
);

const indexerBuildResult = await build({
    ...baseBuildConfig,
    entryPoints: {
        "nats-job-stream-maintenance": path.join(
            rootDir,
            "indexer",
            "src",
            "runtime",
            "nats-job-stream-maintenance.ts",
        ),
        "sqlite-market-data-maintenance": path.join(
            rootDir,
            "indexer",
            "src",
            "runtime",
            "sqlite-market-data-maintenance.ts",
        ),
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
validateLocalRuntimeMetafile(
    RUNTIME_ARTIFACT.Indexer,
    indexerBuildResult.metafile,
);

const tradingBuildResult = await build({
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
validateLocalRuntimeMetafile(
    RUNTIME_ARTIFACT.Trading,
    tradingBuildResult.metafile,
);

const profileMarkerSource = `${JSON.stringify(LOCAL_PROFILE, null, 4)}\n`;
await Promise.all(
    [backendOutDir, indexerOutDir, tradingOutDir].map((outputDirectory) =>
        writeFile(
            path.join(outputDirectory, LOCAL_PROFILE_MARKER),
            profileMarkerSource,
            "utf8",
        ),
    ),
);
