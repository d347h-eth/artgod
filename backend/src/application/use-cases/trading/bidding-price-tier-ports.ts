import type {
    PersistedBiddingPriceTierRecord,
    TradingBiddingPriceTierCeilingConfig,
    TradingBiddingPriceTierFloorConfig,
    TradingBiddingPriceTierStatus,
} from "@artgod/shared/types";

export type UpsertBiddingPriceTierRecordInput = {
    tierId?: string;
    chainId: number;
    collectionId: number;
    name: string;
    status: Exclude<TradingBiddingPriceTierStatus, "archived">;
    sortOrder: number;
    parentTierId: string | null;
    floorConfig: TradingBiddingPriceTierFloorConfig;
    ceilingConfig: TradingBiddingPriceTierCeilingConfig;
    resolvedFloorWei: string;
    resolvedCeilingWei: string;
    resolvedAt: string;
    lastError: string | null;
};

export type BiddingPriceTierResolutionUpdate = {
    tierId: string;
    resolvedFloorWei: string;
    resolvedCeilingWei: string;
    resolvedAt: string;
    lastError: string | null;
};

export interface BiddingPriceTiersRepositoryPort {
    listCollectionPriceTiers(params: {
        chainId: number;
        collectionId: number;
        includeArchived?: boolean;
    }): PersistedBiddingPriceTierRecord[];
    getPriceTierById(tierId: string): PersistedBiddingPriceTierRecord | null;
    upsertPriceTier(
        input: UpsertBiddingPriceTierRecordInput,
    ): PersistedBiddingPriceTierRecord;
    archivePriceTier(tierId: string): PersistedBiddingPriceTierRecord | null;
    updatePriceTierResolutions(
        resolutions: BiddingPriceTierResolutionUpdate[],
    ): void;
}
