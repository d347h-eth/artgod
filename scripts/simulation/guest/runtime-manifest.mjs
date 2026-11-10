import path from "node:path";
import { RUNTIME_READY_MESSAGE as READY } from "../../../shared/runtime/readiness.ts";

// Harness actor aliases stay local: production's Rust/build registries have
// different identities and deliberately explicit membership. These aliases let
// fault drivers refer to this selected composition without repeating strings.
export const RUNTIME_PROCESS = Object.freeze({
    Scheduler: "scheduler",
    Sync: "sync",
    Reorg: "reorg",
    Domain: "domain",
    OffchainIngest: "offchain",
    OpenSeaStream: "stream",
    OpenSeaBootstrap: "source-bootstrap",
    OpenSeaReconcile: "reconcile",
    OpenSeaReconcileScheduler: "reconcile-scheduler",
    Backend: "backend",
    CollectionBootstrap: "collection-bootstrap",
    SqliteStartupMaintenance: "sqlite-startup-maintenance",
    NatsStartupMaintenance: "nats-startup-maintenance",
});

// These are the production build artifacts, rather than test-owned worker compositions.
export const PRODUCTION_RUNTIME_PROCESSES = Object.freeze([
    {
        id: RUNTIME_PROCESS.Scheduler,
        artifact: "indexer/dist-desktop/scheduler-worker.mjs",
        readyMessage: READY.SchedulerWorker,
    },
    {
        id: RUNTIME_PROCESS.Sync,
        artifact: "indexer/dist-desktop/sync-worker.mjs",
        readyMessage: READY.SyncWorker,
    },
    {
        id: RUNTIME_PROCESS.Reorg,
        artifact: "indexer/dist-desktop/reorg-worker.mjs",
        readyMessage: READY.ReorgWorker,
    },
    {
        id: RUNTIME_PROCESS.Domain,
        artifact: "indexer/dist-desktop/domain-worker.mjs",
        readyMessage: READY.DomainWorker,
    },
    {
        id: RUNTIME_PROCESS.OffchainIngest,
        artifact: "indexer/dist-desktop/offchain-ingest-worker.mjs",
        readyMessage: READY.OffchainIngestWorker,
    },
    {
        id: RUNTIME_PROCESS.OpenSeaStream,
        artifact: "indexer/dist-desktop/opensea-stream-worker.mjs",
        readyMessage: READY.OpenSeaStreamWorker,
    },
    {
        id: RUNTIME_PROCESS.OpenSeaBootstrap,
        artifact: "indexer/dist-desktop/opensea-bootstrap-worker.mjs",
        readyMessage: READY.OpenSeaBootstrapWorker,
    },
    {
        id: RUNTIME_PROCESS.OpenSeaReconcile,
        artifact: "indexer/dist-desktop/opensea-reconcile-worker.mjs",
        readyMessage: READY.OpenSeaReconcileWorker,
    },
    {
        id: RUNTIME_PROCESS.OpenSeaReconcileScheduler,
        artifact: "indexer/dist-desktop/opensea-reconcile-scheduler-worker.mjs",
        readyMessage: READY.OpenSeaReconcileSchedulerWorker,
    },
    {
        id: RUNTIME_PROCESS.Backend,
        artifact: "backend/dist-desktop/server.mjs",
        readyMessage: READY.BackendApi,
    },
]);

export const PRODUCTION_STARTUP_MAINTENANCE = Object.freeze([
    {
        id: RUNTIME_PROCESS.SqliteStartupMaintenance,
        artifact: "indexer/dist-desktop/sqlite-market-data-maintenance.mjs",
    },
    {
        id: RUNTIME_PROCESS.NatsStartupMaintenance,
        artifact: "indexer/dist-desktop/nats-job-stream-maintenance.mjs",
    },
]);

// Generic ERC721 bootstrap has no extension-artifact work. Embedded collection
// extensions require their own separately authored external contract fixtures.
export const PRODUCTION_BOOTSTRAP_PROCESSES = Object.freeze([
    {
        id: RUNTIME_PROCESS.CollectionBootstrap,
        artifact: "indexer/dist-desktop/bootstrap-worker.mjs",
        readyMessage: READY.BootstrapWorker,
    },
]);

export function resolveRuntimeLayout(workbenchRoot) {
    const runtime = path.join(workbenchRoot, "runtime");
    return {
        runtime,
        natsBinary: path.join(runtime, "nats/nats-server"),
        sqliteIssuer: path.join(
            runtime,
            "indexer/dist-desktop/domain-worker.mjs",
        ),
        processes: PRODUCTION_RUNTIME_PROCESSES.map((entry) => ({
            ...entry,
            filename: path.join(runtime, entry.artifact),
        })),
        startupMaintenance: PRODUCTION_STARTUP_MAINTENANCE.map((entry) => ({
            ...entry,
            filename: path.join(runtime, entry.artifact),
        })),
        bootstrapProcesses: PRODUCTION_BOOTSTRAP_PROCESSES.map((entry) => ({
            ...entry,
            filename: path.join(runtime, entry.artifact),
        })),
    };
}
