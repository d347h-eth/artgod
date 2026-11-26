import { resolveBatchTraitScope } from "./batch-token-bidding-job-selection.js";
import {
    type CatalogRequest,
    type CatalogScopeReadPort,
} from "../collections/collection-views.js";
import type { ChainRecord, CollectionListItem } from "@artgod/shared/types";
import type { BiddingJobsRepositoryPort } from "./ports.js";
import { type BiddingBidBookRepositoryPort } from "./bidding-bid-book.js";
import {
    resolveBatchTokenBiddingJobSelectionTokenIds,
    type BatchTokenBiddingJobSelectionTokenReadPort,
} from "./batch-token-bidding-job-selection.js";
import {
    mapPersistedTokenBiddingJobToView,
    type BatchTokenBiddingJobSelection,
    type BiddingJobView,
} from "./types.js";

export type LookupBatchTokenBiddingJobsInput = CatalogRequest & {
    chainRef: string;
    collectionRef: string;
    includeOwnJobContext: boolean;
    selection: BatchTokenBiddingJobSelection;
};

export type LookupBatchTokenBiddingJobsOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    tokenIds: string[];
    jobs: BiddingJobView[];
    targetCount: number;
};

export class LookupBatchTokenBiddingJobsUseCase {
    constructor(
        readonly defaultChainId: number,
        readonly chainRefResolverPort: {
            resolveChainRef(
                chainRef: string | undefined,
                defaultPublicChainId: number,
            ): ChainRecord;
        },
        readonly collectionReadPort: CatalogScopeReadPort &
            BatchTokenBiddingJobSelectionTokenReadPort & {
                resolveCollectionRef(
                    chainId: number,
                    collectionRef: string,
                ): CollectionListItem;
            },
        readonly bidBookRepositoryPort: Pick<
            BiddingBidBookRepositoryPort,
            "listCollectionBidBook"
        >,
        readonly biddingJobsRepositoryPort: Pick<
            BiddingJobsRepositoryPort,
            "getTokenJob"
        >,
    ) {}

    lookupBatchTokenBiddingJobs(
        input: LookupBatchTokenBiddingJobsInput,
    ): LookupBatchTokenBiddingJobsOutput {
        // Resolve collection context before expanding the selection into token IDs.
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        const collection = this.collectionReadPort.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );
        const { traitContext, selection } = resolveBatchTraitScope(
            this.collectionReadPort,
            collection,
            input,
        );
        const tokenIds = resolveBatchTokenBiddingJobSelectionTokenIds({
            traitContext,
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            includeOwnJobContext: input.includeOwnJobContext,
            selection,
            collectionReadPort: this.collectionReadPort,
            bidBookRepositoryPort: this.bidBookRepositoryPort,
        });

        const jobs = tokenIds.flatMap((tokenId) => {
            const job = this.biddingJobsRepositoryPort.getTokenJob({
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
                tokenId,
            });
            return job ? [job] : [];
        });

        return {
            chain,
            collection,
            tokenIds,
            jobs: jobs.map((job) => mapPersistedTokenBiddingJobToView(job)),
            targetCount: tokenIds.length,
        };
    }
}
