import type { CollectionStandard } from "./collections.js";

export const BOOTSTRAP_JOB_KIND = {
    Start: "bootstrap.collection.start",
    BackfillCheck: "bootstrap.collection.backfill-check",
} as const;

export type BootstrapCollectionPayload = {
    chainId: number;
    collectionId: string;
    address: string;
    standard: CollectionStandard;
    reason?: string;
};

export type BootstrapBackfillCheckPayload = {
    chainId: number;
    collectionId: string;
    address: string;
    fromBlock: number;
    toBlock: number;
};
