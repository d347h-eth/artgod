import type { Hex } from "./rpc.js";

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

export type BootstrapMetadataTaskStatus =
    | "pending"
    | "retry"
    | "succeeded"
    | "failed_terminal";

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

export type BootstrapMetadataTaskCounts = {
    pending: number;
    retry: number;
    succeeded: number;
    failedTerminal: number;
    total: number;
};

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
}
