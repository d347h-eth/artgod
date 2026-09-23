// OpenSea queue names shared by publishers and workers.
export const OPENSEA_QUEUE_NAME = {
    Bootstrap: "opensea-bootstrap",
    Reconcile: "opensea-reconcile",
} as const;

export const OPENSEA_JOB_KIND = {
    BootstrapCollection: "opensea.collection.bootstrap",
    ReconcileCollection: "opensea.collection.reconcile",
} as const;

// OpenSea job id scopes keep queue de-duplication ids consistent.
export const OPENSEA_JOB_ID_SCOPE = {
    BootstrapCollection: "opensea:bootstrap",
    ReconcileCollection: "opensea:reconcile",
} as const;

// OpenSea bootstrap failure messages are persisted on bootstrap_run_steps.
export const OPENSEA_BOOTSTRAP_FAILURE_MESSAGE = {
    CollectionMissing: "Collection missing for OpenSea bootstrap",
} as const;

// Optional bootstrap context lets OpenSea side-lane phases update run steps.
export type OpenSeaBootstrapContext = {
    runId: number;
};

export type OpenSeaBootstrapCollectionPayload = {
    chainId: number;
    collectionId: number;
    bootstrap?: OpenSeaBootstrapContext | null;
};

export const OPENSEA_RECONCILE_REASON = {
    Scheduled: "scheduled",
    StartupStale: "startup-stale",
    Manual: "manual",
    Retry: "retry",
} as const;

export type OpenSeaReconcileReason =
    (typeof OPENSEA_RECONCILE_REASON)[keyof typeof OPENSEA_RECONCILE_REASON];

export type OpenSeaReconcileCollectionPayload = {
    chainId: number;
    collectionId: number;
    reason: OpenSeaReconcileReason;
};

export const OPENSEA_ORDERBOOK_RUN_KIND = {
    Snapshot: "snapshot",
    Reconcile: "reconcile",
} as const;

export type OpenSeaOrderbookRunKind =
    (typeof OPENSEA_ORDERBOOK_RUN_KIND)[keyof typeof OPENSEA_ORDERBOOK_RUN_KIND];
