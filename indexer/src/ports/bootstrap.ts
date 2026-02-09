import type { Hex } from "./rpc.js";

export type BootstrapSnapshotRow = {
    chainId: number;
    collectionId: string;
    contract: string;
    tokenId: string;
    owner: string;
    anchorBlock: number;
};

export type SnapshotFinalizeInput = {
    chainId: number;
    collectionId: string;
    contract: string;
    anchorBlock: number;
    anchorHash: Hex;
    anchorTimestamp: number;
};

export type BootstrapMetadataTaskStatus =
    | "pending"
    | "retry"
    | "succeeded"
    | "failed_terminal";

export type BootstrapMetadataTaskSeed = {
    chainId: number;
    collectionId: string;
    contract: string;
    standard: "erc721" | "erc1155";
    anchorBlock: number;
    anchorHash: Hex;
    anchorTimestamp: number;
    tokenId: string;
};

export type BootstrapMetadataTask = {
    chainId: number;
    collectionId: string;
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

export type BootstrapMetadataTaskCounts = {
    pending: number;
    retry: number;
    succeeded: number;
    failedTerminal: number;
    total: number;
};

export interface BootstrapSnapshotPort {
    resetSnapshot(chainId: number, collectionId: string): void;
    insertSnapshotRows(rows: BootstrapSnapshotRow[]): void;
    finalizeSnapshot(input: SnapshotFinalizeInput): void;
    resetMetadataTasks(chainId: number, collectionId: string): void;
    insertMetadataTasks(rows: BootstrapMetadataTaskSeed[]): void;
    listMetadataTasksDueNow(
        chainId: number,
        collectionId: string,
        nowMs: number,
        limit: number,
    ): BootstrapMetadataTask[];
    markMetadataTaskSucceeded(
        chainId: number,
        collectionId: string,
        tokenId: string,
        attempts: number,
    ): void;
    markMetadataTaskRetry(
        chainId: number,
        collectionId: string,
        tokenId: string,
        attempts: number,
        nextAttemptAt: number,
        lastError: string,
        failedTerminal: boolean,
    ): void;
    getMetadataTaskCounts(
        chainId: number,
        collectionId: string,
    ): BootstrapMetadataTaskCounts;
    listMetadataTaskTokenIds(chainId: number, collectionId: string): string[];
}
