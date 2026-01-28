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
}
