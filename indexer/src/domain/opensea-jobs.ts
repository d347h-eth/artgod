export const OPENSEA_JOB_KIND = {
    BootstrapCollection: "opensea.collection.bootstrap",
    ReconcileCollection: "opensea.collection.reconcile",
} as const;

export type OpenSeaBootstrapCollectionPayload = {
    chainId: number;
    collectionId: number;
};

export type OpenSeaReconcileCollectionPayload = {
    chainId: number;
    collectionId: number;
    reason: "scheduled" | "startup-stale" | "manual" | "retry";
};

export type OpenSeaOrderbookRunKind = "snapshot" | "reconcile";
