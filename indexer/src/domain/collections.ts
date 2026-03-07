export type CollectionStandard = "erc721" | "erc1155";

export type CollectionStatus = "bootstrapping" | "live" | "paused" | "disabled";

export type OpenSeaCollectionStatus =
    | "pending"
    | "identity_running"
    | "subscribing"
    | "snapshot_pending"
    | "snapshot_running"
    | "ready"
    | "retrying"
    | "failed";

export type CollectionRecord = {
    chainId: number;
    id: number;
    address: string;
    standard: CollectionStandard;
    status: CollectionStatus;
    deploymentBlock: number | null;
    bootstrapAnchorBlock: number | null;
    bootstrapStartedAt: string | null;
    bootstrapFinishedAt: string | null;
    bootstrapLastSyncedBlock: number | null;
    openseaSlug: string | null;
    openseaStatus: OpenSeaCollectionStatus | null;
    openseaReadyAt: string | null;
    openseaSnapshotStartedAt: string | null;
    openseaSnapshotCompletedAt: string | null;
    openseaReconcileStartedAt: string | null;
    openseaReconcileCompletedAt: string | null;
    openseaLastStreamEventAt: string | null;
    openseaLastStreamHealthyAt: string | null;
    openseaLastError: string | null;
};

export type CollectionUpsertInput = Omit<CollectionRecord, "id"> & {
    id?: number;
};
