import { buildIndexerTestWorker } from "./build-indexer-test-worker.mjs";

// Bundle the maintained child fixture like the desktop worker; keep native SQLite external.
export async function buildOrderQueueTestWorker(outfile) {
    await buildIndexerTestWorker({
        entryPoint: "indexer/tests/fixtures/maker-queue-worker.ts",
        outfile,
    });
}
