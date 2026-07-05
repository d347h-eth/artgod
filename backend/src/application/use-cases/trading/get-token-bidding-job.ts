import type { ChainRecord, CollectionListItem } from "@artgod/shared/types";
import type { BiddingJobsRepositoryPort } from "./ports.js";
import type { GetTokenBiddingJobOutput } from "./types.js";
import { mapPersistedTokenBiddingJobToView } from "./types.js";
export type { GetTokenBiddingJobOutput } from "./types.js";

type MaybePromise<T> = T | Promise<T>;

export type GetTokenBiddingJobInput = {
    chainRef: string;
    collectionRef: string;
    tokenRef: string;
};

export class GetTokenBiddingJobUseCase {
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
            getCollectionTokenDetail(params: {
                chainId: number;
                collectionId: number;
                tokenId: string;
            }): MaybePromise<{ tokenId: string }>;
        },
        readonly biddingJobsRepositoryPort: Pick<
            BiddingJobsRepositoryPort,
            "getTokenJob"
        >,
    ) {}

    async getTokenBiddingJob(
        input: GetTokenBiddingJobInput,
    ): Promise<GetTokenBiddingJobOutput> {
        // Resolve the requested chain against the configured backend default.
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        // Resolve the collection before looking up token-scoped job state.
        const collection = this.collectionReadPort.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );
        // Verify the token exists in this collection before returning its job.
        const token = await this.collectionReadPort.getCollectionTokenDetail({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            tokenId: input.tokenRef,
        });
        // Load the active token-scoped bidding job from the authoritative DB store.
        const job = this.biddingJobsRepositoryPort.getTokenJob({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            tokenId: token.tokenId,
        });

        return {
            chain,
            collection,
            tokenId: token.tokenId,
            job: job ? mapPersistedTokenBiddingJobToView(job) : null,
        };
    }
}
