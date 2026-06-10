import type { Hex } from "./rpc.js";
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

export interface BootstrapSnapshotPort {
    resetSnapshot(runId: number): void;
    insertSnapshotRows(rows: BootstrapSnapshotRow[]): void;
    finalizeSnapshot(input: SnapshotFinalizeInput): void;
    resetMetadataTasks(runId: number): void;
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
}
