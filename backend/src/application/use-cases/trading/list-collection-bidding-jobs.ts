import type { ChainRecord, CollectionListItem } from "@artgod/shared/types";
import type { BiddingJobsRepositoryPort } from "./ports.js";
import type { ListCollectionBiddingJobsOutput } from "./types.js";
import { mapPersistedBiddingJobToView } from "./types.js";
export type { ListCollectionBiddingJobsOutput } from "./types.js";

export type ListCollectionBiddingJobsInput = {
    chainRef: string;
    collectionRef: string;
};

export class ListCollectionBiddingJobsUseCase {
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
        },
        readonly biddingJobsRepositoryPort: Pick<
            BiddingJobsRepositoryPort,
            "listCollectionJobs"
        >,
    ) {}

    listCollectionBiddingJobs(
        input: ListCollectionBiddingJobsInput,
    ): ListCollectionBiddingJobsOutput {
        // Resolve the requested chain against the configured backend default.
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        // Resolve the collection before reading its declared bidding jobs.
        const collection = this.collectionReadPort.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );
        // Load the authoritative bidding jobs declared for this collection.
        const jobs = this.biddingJobsRepositoryPort
            .listCollectionJobs({
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
            })
            .map((job) => mapPersistedBiddingJobToView(job));

        return {
            chain,
            collection,
            jobs,
        };
    }
}
