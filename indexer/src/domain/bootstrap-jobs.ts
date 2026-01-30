import type { CollectionStandard } from "./collections.js";

export const BOOTSTRAP_JOB_KIND = {
    Start: "bootstrap.collection.start",
} as const;

export type BootstrapCollectionPayload = {
    chainId: number;
    collectionId: string;
    address: string;
    standard: CollectionStandard;
    reason?: string;
};
