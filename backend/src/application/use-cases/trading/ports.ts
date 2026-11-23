import type { TraitReadContext } from "@artgod/shared/types/trait-catalog";
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
    // Omission preserves the selected version; null clears it. Validate scope,
    // target and availability atomically with the declaration and outbox.
    competitionPresetVersionId?: string | null;
};

export type UpdateBiddingJobPricingByIdInput = {
    chainId: number;
    collectionId: number;
    jobId: string;
    floorWei: string;
    ceilingWei: string;
    deltaWei: string;
    priceTierId: string | null;
    pricingSource: TradingBiddingJobPricingSource;
};

export interface BiddingJobsRepositoryPort {
    listCollectionJobs(params: {
        traitContext?: TraitReadContext;
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
    upsertTokenJob(input: UpsertTokenBiddingJobInput): {
        job: PersistedTokenBiddingJobRecord;
        commands: TradingJobCommandRecord[];
    };
    // Check the selected view and generation for every token under the batch writer lock.
    upsertTokenJobs(
        inputs: UpsertTokenBiddingJobInput[],
        traitContext?: TraitReadContext,
    ): {
        jobs: PersistedTokenBiddingJobRecord[];
        commands: TradingJobCommandRecord[];
    };
    // Run native admission only when creating a declaration. The exact existing
    // target stays editable after metadata or display bindings disappear.
    upsertCollectionJob(
        input: UpsertCollectionBiddingJobInput,
        assertNewTargetSupported?: () => void,
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
    updateJobsPricingById(inputs: UpdateBiddingJobPricingByIdInput[]): {
        jobs: PersistedBiddingJobRecord[];
        commands: TradingJobCommandRecord[];
    };
    listPendingCommands(params: { limit: number }): TradingJobCommandRecord[];
}
