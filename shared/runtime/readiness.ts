/** Stable readiness labels emitted after each runtime's normal startup work. */
export const RUNTIME_READY_MESSAGE = {
    BackendApi: "Backend API ready",
    SchedulerWorker: "Scheduler-worker ready",
    SyncWorker: "Sync worker ready",
    ReorgWorker: "Reorg worker ready",
    DomainWorker: "Domain worker ready",
    OffchainIngestWorker: "Offchain ingest worker ready",
    OpenSeaStreamWorker: "OpenSea stream worker ready",
    OpenSeaBootstrapWorker: "OpenSea bootstrap worker ready",
    OpenSeaReconcileWorker: "OpenSea reconcile worker ready",
    OpenSeaReconcileSchedulerWorker: "OpenSea reconcile scheduler worker ready",
    BootstrapWorker: "Collection bootstrap worker ready",
} as const;

/** Recognize the structured logger boundary without matching quoted diagnostic text. */
export function isRuntimeReadyLog(
    line: string,
    expectedMessage: string,
): boolean {
    try {
        const value: unknown = JSON.parse(line);
        return (
            value !== null &&
            typeof value === "object" &&
            "level" in value &&
            value.level === "info" &&
            "msg" in value &&
            value.msg === expectedMessage
        );
    } catch {
        // Migration output and other plain stdout do not establish readiness.
        return false;
    }
}
