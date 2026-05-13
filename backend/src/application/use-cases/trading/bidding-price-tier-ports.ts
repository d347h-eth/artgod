import {
    TRADING_JOB_STATUS,
    type PersistedBiddingPriceTierRecord,
    type PersistedCollectionSettingRecord,
    type TradingBiddingPriceTierCeilingConfig,
    type TradingBiddingPriceTierFloorConfig,
    type TradingBiddingPriceTierStatus,
} from "@artgod/shared/types";

export type UpsertBiddingPriceTierRecordInput = {
    tierId?: string;
    chainId: number;
    collectionId: number;
    name: string;
    status: Exclude<
        TradingBiddingPriceTierStatus,
        typeof TRADING_JOB_STATUS.Archived
    >;
    sortOrder: number;
    parentTierId: string | null;
    floorConfig: TradingBiddingPriceTierFloorConfig;
    ceilingConfig: TradingBiddingPriceTierCeilingConfig;
    deltaWei: string;
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

export type UpsertCollectionSettingInput = {
    chainId: number;
    collectionId: number;
    key: string;
    valueJson: string;
};

export interface CollectionSettingsRepositoryPort {
    getCollectionSetting(params: {
        chainId: number;
        collectionId: number;
        key: string;
    }): PersistedCollectionSettingRecord | null;
    upsertCollectionSetting(
        input: UpsertCollectionSettingInput,
    ): PersistedCollectionSettingRecord;
}

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
