import type { CollectionStandard } from "./collections.js";

export const BOOTSTRAP_JOB_KIND = {
    Start: "bootstrap.collection.start",
    MetadataProcess: "bootstrap.collection.metadata-process",
    BackfillCheck: "bootstrap.collection.backfill-check",
} as const;

export type BootstrapMetadataSnapshotMode = "strict" | "best_effort";

export type BootstrapCollectionPayload = {
    chainId: number;
    runId: number;
    collectionId: number;
};

export type BootstrapMetadataProcessPayload = {
    chainId: number;
    runId: number;
    collectionId: number;
    address: string;
    standard: CollectionStandard;
    metadataSnapshotMode: BootstrapMetadataSnapshotMode;
    anchorBlock: number;
    anchorHash: string;
    anchorTimestamp: number;
};

export type BootstrapBackfillCheckPayload = {
    chainId: number;
    runId: number;
    collectionId: number;
    address: string;
    fromBlock: number;
    toBlock: number;
};
