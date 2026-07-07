import type {
    ChainRecord,
    CollectionListItem,
    TokenCard,
    TokenBrowserStatus,
    TokenCursorPage,
    TraitFilter,
    TraitRangeFilter,
} from "@artgod/shared/types";
import type {
    BiddingJobsRepositoryPort,
    UpsertTokenBiddingJobInput as PersistedUpsertTokenBiddingJobInput,
} from "./ports.js";
import {
    resolveBiddingJobPricing,
    type BiddingJobPriceTierReadPort,
} from "./bidding-job-pricing.js";
import type {
    BatchTokenBiddingJobSelection,
    UpsertBatchTokenBiddingJobsOutput,
} from "./types.js";
import {
    mapPersistedTokenBiddingJobToView,
    TradingValidationError,
    type TokenBiddingJobMutationStatus,
} from "./types.js";
import type { TradingJobCommandSignalPort } from "./trading-job-command-signal-port.js";
import { type BiddingBidBookRepositoryPort } from "./bidding-bid-book.js";
import { resolveBatchTokenBiddingJobSelectionTokenIds } from "./batch-token-bidding-job-selection.js";
export type { UpsertBatchTokenBiddingJobsOutput } from "./types.js";

export type UpsertBatchTokenBiddingJobsInput = {
    chainRef: string;
    collectionRef: string;
    includeOwnJobContext: boolean;
    status: TokenBiddingJobMutationStatus;
    floorEth?: string;
    ceilingEth?: string;
    deltaEth: string;
    priceTierId?: string | null;
    selection: BatchTokenBiddingJobSelection;
};

export class UpsertBatchTokenBiddingJobsUseCase {
    constructor(
        readonly defaultChainId: number,
        readonly chainRefResolverPort: {
            resolveChainRef(
                chainRef: string | undefined,
                defaultPublicChainId: number,
            ): ChainRecord;
        },
        readonly collectionReadPort: {
            resolveCollectionRef(
                chainId: number,
                collectionRef: string,
            ): CollectionListItem;
            listCollectionTokens(params: {
                chainId: number;
                collectionId: number;
                tokenStatus: TokenBrowserStatus;
                limit: number;
                cursor?: string;
                traitFilters?: TraitFilter[];
                traitRangeFilters?: TraitRangeFilter[];
                owner?: string;
            }): TokenCursorPage;
            listCollectionTokenCardsByIds(params: {
                chainId: number;
                collectionId: number;
                tokenIds: string[];
            }): TokenCard[];
        },
        readonly bidBookRepositoryPort: Pick<
            BiddingBidBookRepositoryPort,
            "listCollectionBidBook"
        >,
        readonly biddingJobsRepositoryPort: Pick<
            BiddingJobsRepositoryPort,
            "upsertTokenJobs"
        >,
        readonly biddingPriceTiersRepositoryPort: BiddingJobPriceTierReadPort,
        readonly tradingJobCommandSignalPort: TradingJobCommandSignalPort,
    ) {}

    upsertBatchTokenBiddingJobs(
        input: UpsertBatchTokenBiddingJobsInput,
    ): UpsertBatchTokenBiddingJobsOutput {
        // Resolve the requested chain against the configured backend default.
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        // Resolve the collection before resolving its token selection.
        const collection = this.collectionReadPort.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );

        // Resolve manual or tier-backed pricing into bot-facing scalar wei values.
        const pricing = resolveBiddingJobPricing({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            input,
            priceTierReadPort: this.biddingPriceTiersRepositoryPort,
        });

        const tokenIds = resolveBatchTokenBiddingJobSelectionTokenIds({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            includeOwnJobContext: input.includeOwnJobContext,
            selection: input.selection,
            collectionReadPort: this.collectionReadPort,
            bidBookRepositoryPort: this.bidBookRepositoryPort,
        });
        if (tokenIds.length === 0) {
            throw new TradingValidationError("token selection is empty");
        }

        const persistedInputs: PersistedUpsertTokenBiddingJobInput[] =
            tokenIds.map((tokenId) => ({
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
                tokenId,
                status: input.status,
                floorWei: pricing.floorWei,
                ceilingWei: pricing.ceilingWei,
                deltaWei: pricing.deltaWei,
                priceTierId: pricing.priceTierId,
                pricingSource: pricing.pricingSource,
            }));
        // Persist the batch as one SQLite transaction and enqueue one command per affected job.
        const result =
            this.biddingJobsRepositoryPort.upsertTokenJobs(persistedInputs);
        // Publish a post-commit wake-up so the running bot scans all durable command rows immediately.
        this.tradingJobCommandSignalPort.publishBiddingJobCommandsChanged(
            result.commands,
        );

        return {
            chain,
            collection,
            tokenIds,
            jobs: result.jobs.map((job) =>
                mapPersistedTokenBiddingJobToView(job),
            ),
        };
    }
}
