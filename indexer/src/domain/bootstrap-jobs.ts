import type { CollectionStandard } from "./collections.js";

export const BOOTSTRAP_JOB_KIND = {
    Start: "bootstrap.collection.start",
    MetadataProcess: "bootstrap.collection.metadata-process",
    BackfillCheck: "bootstrap.collection.backfill-check",
} as const;

export type BootstrapMetadataSnapshotMode = "strict" | "best_effort";

export type BootstrapCollectionPayload = {
    chainId: number;
    collectionId: string;
    address: string;
    standard: CollectionStandard;
    metadataSnapshotMode: BootstrapMetadataSnapshotMode;
    reason?: string;
};

export type BootstrapMetadataProcessPayload = {
    chainId: number;
    collectionId: string;
    address: string;
    standard: CollectionStandard;
    metadataSnapshotMode: BootstrapMetadataSnapshotMode;
    anchorBlock: number;
    anchorHash: string;
    anchorTimestamp: number;
};

export type BootstrapBackfillCheckPayload = {
    chainId: number;
    collectionId: string;
    address: string;
    fromBlock: number;
    toBlock: number;
};
