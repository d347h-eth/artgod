import { formatEther, parseEther } from "viem";
import type {
    ChainRecord,
    CollectionListItem,
    PersistedBiddingJobRecord,
    PersistedTokenBiddingJobRecord,
    TradingJobStatus,
    TradingTraitCriterion,
} from "@artgod/shared/types";

export type TokenBiddingJobMutationStatus = Exclude<TradingJobStatus, "archived">;

export type BiddingJobView = {
    jobId: string;
    status: TradingJobStatus;
    revision: number;
    createdAt: string;
    updatedAt: string;
    archivedAt: string | null;
    target:
        | {
              type: "token";
              tokenId: string;
          }
        | {
              type: "collection";
              quantity: number;
              targetTraits: TradingTraitCriterion[];
          }
        | {
              type: "competitiveTrait";
              quantity: number;
              targetTraits: TradingTraitCriterion[];
              competitorTraits: TradingTraitCriterion[];
          };
    config: {
        floorEth: string;
        ceilingEth: string;
        deltaEth: string;
    };
    runtime: {
        currentPriceEth: string | null;
        activeOrderId: string | null;
        activeProtocolAddress: string | null;
        activeExpirationTimeMs: number | null;
        lastRunAt: string | null;
        lastError: string | null;
    } | null;
};

export type ListCollectionBiddingJobsInput = {
    chainRef: string;
    collectionRef: string;
};

export type ListCollectionBiddingJobsOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    jobs: BiddingJobView[];
};

export type GetTokenBiddingJobInput = {
    chainRef: string;
    collectionRef: string;
    tokenRef: string;
};

export type GetTokenBiddingJobOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    tokenId: string;
    job: BiddingJobView | null;
};

export type UpsertTokenBiddingJobInput = {
    chainRef: string;
    collectionRef: string;
    tokenRef: string;
    status: TokenBiddingJobMutationStatus;
    floorEth: string;
    ceilingEth: string;
    deltaEth: string;
};

export type UpsertTokenBiddingJobOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    tokenId: string;
    job: BiddingJobView;
};

export type ArchiveTokenBiddingJobInput = {
    chainRef: string;
    collectionRef: string;
    tokenRef: string;
};

export type ArchiveTokenBiddingJobOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    tokenId: string;
    job: BiddingJobView;
};

export class TradingValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TradingValidationError";
    }
}

export function parsePositiveEthToWei(value: string, field: string): string {
    const normalized = value.trim();
    if (!normalized) {
        throw new TradingValidationError(`${field} is required`);
    }

    try {
        const amount = parseEther(normalized);
        if (amount <= 0n) {
            throw new TradingValidationError(`${field} must be > 0`);
        }
        return amount.toString();
    } catch (error: unknown) {
        if (error instanceof TradingValidationError) {
            throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new TradingValidationError(`${field} is invalid: ${message}`);
    }
}

export function assertFloorNotAboveCeiling(
    floorWei: string,
    ceilingWei: string,
): void {
    if (BigInt(floorWei) > BigInt(ceilingWei)) {
        throw new TradingValidationError("floorEth must be <= ceilingEth");
    }
}

export function mapPersistedBiddingJobToView(
    job: PersistedBiddingJobRecord,
): BiddingJobView {
    const runtime = job.runtime
        ? {
              currentPriceEth: formatOptionalWeiAsEth(job.runtime.currentPriceWei),
              activeOrderId: job.runtime.activeOrderId,
              activeProtocolAddress: job.runtime.activeProtocolAddress,
              activeExpirationTimeMs: job.runtime.activeExpirationTimeMs,
              lastRunAt: job.runtime.lastRunAt,
              lastError: job.runtime.lastError,
          }
        : null;

    if (job.targetKind === "token") {
        return {
            jobId: job.jobId,
            status: job.status,
            revision: job.revision,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
            archivedAt: job.archivedAt,
            target: {
                type: "token",
                tokenId: job.tokenId,
            },
            config: {
                floorEth: formatWeiAsEth(job.floorWei),
                ceilingEth: formatWeiAsEth(job.ceilingWei),
                deltaEth: formatWeiAsEth(job.deltaWei),
            },
            runtime,
        };
    }

    if (job.targetKind === "collection") {
        return {
            jobId: job.jobId,
            status: job.status,
            revision: job.revision,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
            archivedAt: job.archivedAt,
            target: {
                type: "collection",
                quantity: job.quantity,
                targetTraits: job.targetTraits,
            },
            config: {
                floorEth: formatWeiAsEth(job.floorWei),
                ceilingEth: formatWeiAsEth(job.ceilingWei),
                deltaEth: formatWeiAsEth(job.deltaWei),
            },
            runtime,
        };
    }

    return {
        jobId: job.jobId,
        status: job.status,
        revision: job.revision,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        archivedAt: job.archivedAt,
        target: {
            type: "competitiveTrait",
            quantity: job.quantity,
            targetTraits: job.targetTraits,
            competitorTraits: job.competitorTraits,
        },
        config: {
            floorEth: formatWeiAsEth(job.floorWei),
            ceilingEth: formatWeiAsEth(job.ceilingWei),
            deltaEth: formatWeiAsEth(job.deltaWei),
        },
        runtime,
    };
}

export function mapPersistedTokenBiddingJobToView(
    job: PersistedTokenBiddingJobRecord,
): BiddingJobView {
    return mapPersistedBiddingJobToView(job);
}

function formatWeiAsEth(value: string): string {
    return formatEther(BigInt(value));
}

function formatOptionalWeiAsEth(value: string | null): string | null {
    return value === null ? null : formatWeiAsEth(value);
}
