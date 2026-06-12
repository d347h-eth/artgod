import type { Hex } from "./rpc.js";
import type { CollectionExtensionKey } from "@artgod/shared/extensions";
import type {
    BootstrapTaskCounts,
    BootstrapTaskStatus,
} from "@artgod/shared/bootstrap/pipeline";

export type BootstrapSnapshotRow = {
    runId: number;
    chainId: number;
    collectionId: number;
    contract: string;
    tokenId: string;
    owner: string;
    anchorBlock: number;
};

export type SnapshotFinalizeInput = {
    runId: number;
    chainId: number;
    collectionId: number;
    contract: string;
    anchorBlock: number;
    anchorHash: Hex;
    anchorTimestamp: number;
};

export type BootstrapMetadataTaskStatus = BootstrapTaskStatus;

export type BootstrapMetadataTaskSeed = {
    runId: number;
    chainId: number;
    collectionId: number;
    contract: string;
    standard: "erc721" | "erc1155";
    anchorBlock: number;
    anchorHash: Hex;
    anchorTimestamp: number;
    tokenId: string;
};

export type BootstrapMetadataTask = {
    runId: number;
    chainId: number;
    collectionId: number;
    contract: string;
    tokenId: string;
    standard: "erc721" | "erc1155";
    anchorBlock: number;
    anchorHash: Hex;
    anchorTimestamp: number;
    status: BootstrapMetadataTaskStatus;
    attempts: number;
    nextAttemptAt: number;
};

export type BootstrapMetadataTaskCounts = BootstrapTaskCounts;

export type BootstrapImageCacheTaskStatus = BootstrapTaskStatus;

export type BootstrapImageCacheTask = {
    runId: number;
    chainId: number;
    collectionId: number;
    contract: string;
    tokenId: string;
    sourceImageUrl: string;
    requestedMaxDimension: number | null;
    status: BootstrapImageCacheTaskStatus;
    attempts: number;
    nextAttemptAt: number;
};

export type BootstrapImageCacheTaskCounts = BootstrapTaskCounts;

export type BootstrapOwnershipTaskSeed = {
    runId: number;
    chainId: number;
    collectionId: number;
    contract: string;
    standard: "erc721" | "erc1155";
    anchorBlock: number;
    anchorHash: Hex;
    anchorTimestamp: number;
    tokenId: string;
};

export type BootstrapOwnershipTask = BootstrapOwnershipTaskSeed & {
    status: BootstrapTaskStatus;
    attempts: number;
    nextAttemptAt: number;
};

export type BootstrapOwnershipTaskCounts = BootstrapTaskCounts;

export type BootstrapCollectionExtensionArtifactTask = {
    runId: number;
    chainId: number;
    collectionId: number;
    contract: string;
    tokenId: string;
    extensionKey: CollectionExtensionKey;
    status: BootstrapTaskStatus;
    attempts: number;
    nextAttemptAt: number;
};

export type BootstrapCollectionExtensionArtifactTaskCounts =
    BootstrapTaskCounts;

export interface BootstrapSnapshotPort {
    resetSnapshot(runId: number): void;
    insertSnapshotRows(rows: BootstrapSnapshotRow[]): void;
    finalizeSnapshot(input: SnapshotFinalizeInput): void;
    deleteRunTemporaryData(runId: number): void;
    deleteSnapshotRows(runId: number): number;
    resetMetadataTasks(runId: number): void;
    deleteSucceededMetadataTasks(runId: number): number;
    insertMetadataTasks(rows: BootstrapMetadataTaskSeed[]): void;
    listMetadataTasksDueNow(
        runId: number,
        nowMs: number,
        limit: number,
    ): BootstrapMetadataTask[];
    markMetadataTaskSucceeded(
        runId: number,
        tokenId: string,
        attempts: number,
    ): void;
    markMetadataTaskRetry(
        runId: number,
        tokenId: string,
        attempts: number,
        nextAttemptAt: number,
        lastError: string,
        failedTerminal: boolean,
    ): void;
    getMetadataTaskCounts(runId: number): BootstrapMetadataTaskCounts;
    listMetadataTaskTokenIds(runId: number): string[];
    resetImageCacheTasks(runId: number): void;
    deleteSucceededImageCacheTasks(runId: number): number;
    seedImageCacheTasks(input: {
        runId: number;
        requestedMaxDimension: number | null;
    }): number;
    listImageCacheTasksDueNow(
        runId: number,
        nowMs: number,
        limit: number,
    ): BootstrapImageCacheTask[];
    markImageCacheTaskSucceeded(input: {
        runId: number;
        tokenId: string;
        attempts: number;
        cacheKey: string;
        contentType: string;
        sourceBytes: number;
        cachedBytes: number;
        width: number | null;
        height: number | null;
        relativePath: string;
        publicPath: string;
    }): void;
    markImageCacheTaskRetry(input: {
        runId: number;
        tokenId: string;
        attempts: number;
        nextAttemptAt: number;
        lastError: string;
        failedTerminal: boolean;
    }): void;
    getImageCacheTaskCounts(runId: number): BootstrapImageCacheTaskCounts;
    resetOwnershipTasks(runId: number): void;
    deleteSucceededOwnershipTasks(runId: number): number;
    insertOwnershipTasks(rows: BootstrapOwnershipTaskSeed[]): void;
    listOwnershipTasksDueNow(
        runId: number,
        nowMs: number,
        limit: number,
    ): BootstrapOwnershipTask[];
    markOwnershipTaskSucceeded(input: {
        runId: number;
        tokenId: string;
        attempts: number;
        owner: string;
    }): void;
    markOwnershipTaskRetry(input: {
        runId: number;
        tokenId: string;
        attempts: number;
        nextAttemptAt: number;
        lastError: string;
        failedTerminal: boolean;
    }): void;
    getOwnershipTaskCounts(runId: number): BootstrapOwnershipTaskCounts;
    deleteSucceededCollectionExtensionArtifactTasks(runId: number): number;
    seedCollectionExtensionArtifactTasks(input: {
        runId: number;
        extensionKey: CollectionExtensionKey;
    }): number;
    listCollectionExtensionArtifactTasksDueNow(
        runId: number,
        nowMs: number,
        limit: number,
    ): BootstrapCollectionExtensionArtifactTask[];
    listCollectionExtensionArtifactTasksToPublish(
        runId: number,
        cursorTokenId: string | null,
        limit: number,
    ): BootstrapCollectionExtensionArtifactTask[];
    getCollectionExtensionArtifactTask(input: {
        runId: number;
        tokenId: string;
        extensionKey: CollectionExtensionKey;
    }): BootstrapCollectionExtensionArtifactTask | null;
    markCollectionExtensionArtifactTaskSucceeded(input: {
        runId: number;
        tokenId: string;
        extensionKey: CollectionExtensionKey;
        attempts: number;
    }): void;
    markCollectionExtensionArtifactTaskRetry(input: {
        runId: number;
        tokenId: string;
        extensionKey: CollectionExtensionKey;
        attempts: number;
        nextAttemptAt: number;
        lastError: string;
        failedTerminal: boolean;
    }): void;
    getCollectionExtensionArtifactTaskCounts(
        runId: number,
    ): BootstrapCollectionExtensionArtifactTaskCounts;
}
