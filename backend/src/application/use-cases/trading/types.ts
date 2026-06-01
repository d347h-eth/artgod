import { formatEther, parseEther } from "viem";
import type {
    ChainRecord,
    CollectionListItem,
    CollectionBiddingTraitFilterJoinMode,
    PersistedBiddingJobRecord,
    PersistedTokenBiddingJobRecord,
    TokenBrowserStatus,
    TraitFilter,
    TraitRangeFilter,
    TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND,
    TradingBiddingJobRuntimeBidPosition,
    TradingBiddingJobRuntimeConstraint,
    TradingBiddingJobPricingSource,
    TradingJobStatus,
    TradingTraitCriterion,
} from "@artgod/shared/types";

export type BiddingJobMutationStatus = Exclude<TradingJobStatus, "archived">;
export type TokenBiddingJobMutationStatus = BiddingJobMutationStatus;

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
        pricingSource: TradingBiddingJobPricingSource | null;
    };
    runtime: {
        currentPriceEth: string | null;
        activeOrderId: string | null;
        activeProtocolAddress: string | null;
        activeExpirationTimeMs: number | null;
        bidPosition: TradingBiddingJobRuntimeBidPosition | null;
        bidConstraints: TradingBiddingJobRuntimeConstraint[];
        competitorPriceEth: string | null;
        lastRunAt: string | null;
        lastError: string | null;
        updatedAt: string;
    } | null;
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
    floorEth?: string;
    ceilingEth?: string;
    deltaEth: string;
    priceTierId?: string | null;
};

export type UpsertTokenBiddingJobOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    tokenId: string;
    job: BiddingJobView;
};

export type BatchTokenBiddingJobSelection =
    | {
          type: typeof TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenIds;
          tokenIds: string[];
      }
    | {
          type: typeof TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenBrowserFilter;
          tokenStatus: TokenBrowserStatus;
          traits: TraitFilter[];
          traitRanges: TraitRangeFilter[];
      }
    | {
          type: typeof TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenOfferFilter;
          traits: TraitFilter[];
          traitRanges: TraitRangeFilter[];
          traitJoinMode: CollectionBiddingTraitFilterJoinMode;
          makerAddress?: string | null;
      };

export type UpsertBatchTokenBiddingJobsInput = {
    chainRef: string;
    collectionRef: string;
    status: TokenBiddingJobMutationStatus;
    floorEth?: string;
    ceilingEth?: string;
    deltaEth: string;
    priceTierId?: string | null;
    selection: BatchTokenBiddingJobSelection;
};

export type UpsertBatchTokenBiddingJobsOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    tokenIds: string[];
    jobs: BiddingJobView[];
};

export type UpsertTraitBiddingJobInput = {
    chainRef: string;
    collectionRef: string;
    status: BiddingJobMutationStatus;
    floorEth?: string;
    ceilingEth?: string;
    deltaEth: string;
    priceTierId?: string | null;
    quantity?: number;
    targetTraits: TradingTraitCriterion[];
};

export type UpsertTraitBiddingJobOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    job: BiddingJobView;
};

export type UpsertCollectionBiddingJobInput = {
    chainRef: string;
    collectionRef: string;
    status: BiddingJobMutationStatus;
    floorEth?: string;
    ceilingEth?: string;
    deltaEth: string;
    priceTierId?: string | null;
    quantity?: number;
};

export type UpsertCollectionBiddingJobOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
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
              bidPosition: job.runtime.bidPosition,
              bidConstraints: job.runtime.bidConstraints,
              competitorPriceEth: formatOptionalWeiAsEth(
                  job.runtime.competitorPriceWei,
              ),
              lastRunAt: job.runtime.lastRunAt,
              lastError: job.runtime.lastError,
              updatedAt: job.runtime.updatedAt,
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
                pricingSource: job.pricingSource,
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
                pricingSource: job.pricingSource,
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
            pricingSource: job.pricingSource,
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
