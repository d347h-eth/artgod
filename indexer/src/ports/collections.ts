import type {
    CollectionRecord,
    CollectionUpsertInput,
    OpenSeaCollectionStatus,
} from "../domain/collections.js";

export type CollectionSyncMode = "realtime" | "backfill";

export type CollectionScopeRange = {
    collectionId: number;
    fromTokenId: string;
    toTokenId: string;
};

export interface CollectionRegistryPort {
    getCollection(
        chainId: number,
        collectionId: number,
    ): CollectionRecord | null;
    listCollectionsForSync(
        chainId: number,
        mode: CollectionSyncMode,
    ): CollectionRecord[];
    listCollectionsForOpenSeaSubscription(chainId: number): CollectionRecord[];
    listCollectionsForOpenSeaReconcile(
        chainId: number,
        staleBeforeIso: string,
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
    markOpenSeaPending(chainId: number, collectionId: number): boolean;
    markOpenSeaIdentityRunning(chainId: number, collectionId: number): boolean;
    setOpenSeaSlug(
        chainId: number,
        collectionId: number,
        slug: string,
    ): boolean;
    setOpenSeaStatus(
        chainId: number,
        collectionId: number,
        status: OpenSeaCollectionStatus,
        errorMessage?: string | null,
    ): boolean;
    markOpenSeaSnapshotStarted(chainId: number, collectionId: number): boolean;
    markOpenSeaSnapshotCompleted(
        chainId: number,
        collectionId: number,
    ): boolean;
    markOpenSeaReconcileStarted(chainId: number, collectionId: number): boolean;
    markOpenSeaReconcileCompleted(
        chainId: number,
        collectionId: number,
    ): boolean;
    markOpenSeaReady(chainId: number, collectionId: number): boolean;
    touchOpenSeaStreamHealthy(chainId: number, collectionId: number): boolean;
    touchOpenSeaStreamEvent(chainId: number, collectionId: number): boolean;
}

export interface CollectionScopeResolverPort {
    resolveTokenScopedCollectionId(
        chainId: number,
        collections: CollectionRecord[],
        contract: string,
        tokenId: string,
    ): number | null;
    resolveContractScopedCollectionIds(
        chainId: number,
        collections: CollectionRecord[],
        contract: string,
    ): number[];
    splitRangeByCollectionScope(
        chainId: number,
        collections: CollectionRecord[],
        contract: string,
        fromTokenId: string,
        toTokenId: string,
    ): CollectionScopeRange[];
}
