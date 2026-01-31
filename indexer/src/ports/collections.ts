import type {
    CollectionRecord,
    CollectionUpsertInput,
} from "../domain/collections.js";

export type CollectionSyncMode = "realtime" | "backfill";

export interface CollectionRegistryPort {
    listCollectionsForSync(
        chainId: number,
        mode: CollectionSyncMode,
    ): CollectionRecord[];
    upsertCollection(input: CollectionUpsertInput): void;
    markBootstrapStarted(
        chainId: number,
        collectionId: string,
        anchorBlock: number,
    ): boolean;
    markBootstrapSnapshotProgress(
        chainId: number,
        collectionId: string,
        lastSyncedBlock: number,
    ): boolean;
}
