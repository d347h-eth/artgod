import type { ChainRecord, CollectionListItem } from "@artgod/shared/types";
import type {
    BiddingJobsRepositoryPort,
    UpsertTokenBiddingJobInput as PersistedUpsertTokenBiddingJobInput,
} from "./ports.js";
import type { UpsertTokenBiddingJobOutput } from "./types.js";
import {
    assertFloorNotAboveCeiling,
    mapPersistedTokenBiddingJobToView,
    parsePositiveEthToWei,
    type TokenBiddingJobMutationStatus,
} from "./types.js";
export type { UpsertTokenBiddingJobOutput } from "./types.js";

export type UpsertTokenBiddingJobInput = {
    chainRef: string;
    collectionRef: string;
    tokenRef: string;
    status: TokenBiddingJobMutationStatus;
    floorEth: string;
    ceilingEth: string;
    deltaEth: string;
};

export class UpsertTokenBiddingJobUseCase {
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
            }): { tokenId: string };
        },
        readonly biddingJobsRepositoryPort: Pick<
            BiddingJobsRepositoryPort,
            "upsertTokenJob"
        >,
    ) {}

    upsertTokenBiddingJob(
        input: UpsertTokenBiddingJobInput,
    ): UpsertTokenBiddingJobOutput {
        // Resolve the requested chain against the configured backend default.
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        // Resolve the collection before mutating its token-scoped job.
        const collection = this.collectionReadPort.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );
        // Verify the token exists in this collection before mutating its job.
        const token = this.collectionReadPort.getCollectionTokenDetail({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            tokenId: input.tokenRef,
        });

        // Normalize the human-readable Ether inputs into canonical wei strings.
        const floorWei = parsePositiveEthToWei(input.floorEth, "floorEth");
        const ceilingWei = parsePositiveEthToWei(
            input.ceilingEth,
            "ceilingEth",
        );
        const deltaWei = parsePositiveEthToWei(input.deltaEth, "deltaEth");
        assertFloorNotAboveCeiling(floorWei, ceilingWei);

        const persistedInput: PersistedUpsertTokenBiddingJobInput = {
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            tokenId: token.tokenId,
            status: input.status,
            floorWei,
            ceilingWei,
            deltaWei,
        };
        // Persist the desired job state and enqueue the matching Outbox command.
        const result = this.biddingJobsRepositoryPort.upsertTokenJob(
            persistedInput,
        );

        return {
            chain,
            collection,
            tokenId: token.tokenId,
            job: mapPersistedTokenBiddingJobToView(result.job),
        };
    }
}
