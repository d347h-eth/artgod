import type { CollectionStandard } from "./collections.js";
import type { BootstrapMetadataMode } from "@artgod/shared/bootstrap/pipeline";

export { BOOTSTRAP_JOB_KIND } from "@artgod/shared/bootstrap/jobs";

export type BootstrapMetadataSnapshotMode = BootstrapMetadataMode;

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

export type BootstrapImageCacheProcessPayload = {
    chainId: number;
    runId: number;
    collectionId: number;
    address: string;
    standard: CollectionStandard;
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
