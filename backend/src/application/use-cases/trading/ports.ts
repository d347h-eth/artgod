import type {
    PersistedBiddingJobRecord,
    PersistedCollectionBiddingJobRecord,
    PersistedTokenBiddingJobRecord,
    TradingBiddingJobTargetDescriptor,
    TradingBiddingJobPricingSource,
    TradingJobCommandRecord,
    TradingJobStatus,
    TradingTraitCriterion,
} from "@artgod/shared/types";

export type UpsertTokenBiddingJobInput = {
    chainId: number;
    collectionId: number;
    tokenId: string;
    status: Exclude<TradingJobStatus, "archived">;
    floorWei: string;
    ceilingWei: string;
    deltaWei: string;
    priceTierId?: string | null;
    pricingSource?: TradingBiddingJobPricingSource | null;
};

export type UpsertCollectionBiddingJobInput = {
    chainId: number;
    collectionId: number;
    status: Exclude<TradingJobStatus, "archived">;
    floorWei: string;
    ceilingWei: string;
    deltaWei: string;
    priceTierId?: string | null;
    pricingSource?: TradingBiddingJobPricingSource | null;
    quantity: number;
    targetTraits: TradingTraitCriterion[];
};

export interface BiddingJobsRepositoryPort {
    listCollectionJobs(params: {
        chainId: number;
        collectionId: number;
        includeArchived?: boolean;
    }): PersistedBiddingJobRecord[];
    getTokenJob(params: {
        chainId: number;
        collectionId: number;
        tokenId: string;
        includeArchived?: boolean;
    }): PersistedTokenBiddingJobRecord | null;
    getJobById(jobId: string): PersistedBiddingJobRecord | null;
    findJobByTarget(params: {
        chainId: number;
        collectionId: number;
        target: TradingBiddingJobTargetDescriptor;
        includeArchived?: boolean;
    }): PersistedBiddingJobRecord | null;
    upsertTokenJob(
        input: UpsertTokenBiddingJobInput,
    ): {
        job: PersistedTokenBiddingJobRecord;
        commands: TradingJobCommandRecord[];
    };
    upsertTokenJobs(
        inputs: UpsertTokenBiddingJobInput[],
    ): {
        jobs: PersistedTokenBiddingJobRecord[];
        commands: TradingJobCommandRecord[];
    };
    upsertCollectionJob(
        input: UpsertCollectionBiddingJobInput,
    ): {
        job: PersistedCollectionBiddingJobRecord;
        commands: TradingJobCommandRecord[];
    };
    archiveTokenJob(params: {
        chainId: number;
        collectionId: number;
        tokenId: string;
    }): {
        job: PersistedTokenBiddingJobRecord;
        commands: TradingJobCommandRecord[];
    } | null;
    archiveJobById(params: {
        chainId: number;
        collectionId: number;
        jobId: string;
    }): {
        job: PersistedBiddingJobRecord;
        commands: TradingJobCommandRecord[];
    } | null;
    listPendingCommands(params: {
        limit: number;
    }): TradingJobCommandRecord[];
}
