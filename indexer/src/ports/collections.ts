import type {
    CollectionRecord,
    CollectionUpsertInput,
} from "../domain/collections.js";

export type CollectionSyncMode = "realtime" | "backfill";

export interface CollectionRegistryPort {
    getCollection(
        chainId: number,
        collectionId: number,
    ): CollectionRecord | null;
    listCollectionsForSync(
        chainId: number,
        mode: CollectionSyncMode,
    ): CollectionRecord[];
    upsertCollection(input: CollectionUpsertInput): void;
    markBootstrapStarted(
        chainId: number,
        collectionId: number,
        anchorBlock: number,
    ): boolean;
    markBootstrapSnapshotProgress(
        chainId: number,
        collectionId: number,
        lastSyncedBlock: number,
    ): boolean;
    markBootstrapFinished(
        chainId: number,
        collectionId: number,
        lastSyncedBlock: number,
    ): boolean;
}
