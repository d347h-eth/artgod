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

export interface BootstrapSnapshotPort {
    resetSnapshot(chainId: number, collectionId: string): void;
    insertSnapshotRows(rows: BootstrapSnapshotRow[]): void;
    finalizeSnapshot(input: SnapshotFinalizeInput): void;
}
