import type {
    PersistedBiddingJobRecord,
    PersistedTokenBiddingJobRecord,
    TradingJobCommandRecord,
    TradingJobStatus,
} from "@artgod/shared/types";

export type UpsertTokenBiddingJobInput = {
    chainId: number;
    collectionId: number;
    tokenId: string;
    status: Exclude<TradingJobStatus, "archived">;
    floorWei: string;
    ceilingWei: string;
    deltaWei: string;
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
    upsertTokenJob(
        input: UpsertTokenBiddingJobInput,
    ): {
        job: PersistedTokenBiddingJobRecord;
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
    listPendingCommands(params: {
        limit: number;
    }): TradingJobCommandRecord[];
}
