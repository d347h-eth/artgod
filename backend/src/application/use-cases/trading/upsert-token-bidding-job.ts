import type { ChainRecord, CollectionListItem } from "@artgod/shared/types";
import type {
    BiddingJobsRepositoryPort,
    UpsertTokenBiddingJobInput as PersistedUpsertTokenBiddingJobInput,
} from "./ports.js";
import {
    resolveBiddingJobPricing,
    type BiddingJobPriceTierReadPort,
} from "./bidding-job-pricing.js";
import type { UpsertTokenBiddingJobOutput } from "./types.js";
import {
    mapPersistedTokenBiddingJobToView,
    type TokenBiddingJobMutationStatus,
} from "./types.js";
import { assertTokenMarketplaceBiddingSupported } from "./token-marketplace-bidding.js";
import type { TradingJobCommandSignalPort } from "./trading-job-command-signal-port.js";
export type { UpsertTokenBiddingJobOutput } from "./types.js";

type MaybePromise<T> = T | Promise<T>;

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
            }): MaybePromise<{
                tokenId: string;
                marketplaceBiddingSupported: boolean;
            }>;
        },
        readonly biddingJobsRepositoryPort: Pick<
            BiddingJobsRepositoryPort,
            "upsertTokenJob"
        >,
        readonly biddingPriceTiersRepositoryPort: BiddingJobPriceTierReadPort,
        readonly tradingJobCommandSignalPort: TradingJobCommandSignalPort,
    ) {}

    async upsertTokenBiddingJob(
        input: UpsertTokenBiddingJobInput,
    ): Promise<UpsertTokenBiddingJobOutput> {
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
        const token = await this.collectionReadPort.getCollectionTokenDetail({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            tokenId: input.tokenRef,
        });
        assertTokenMarketplaceBiddingSupported(token);

        // Resolve manual or tier-backed pricing into bot-facing scalar wei values.
        const pricing = resolveBiddingJobPricing({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            input,
            priceTierReadPort: this.biddingPriceTiersRepositoryPort,
        });

        const persistedInput: PersistedUpsertTokenBiddingJobInput = {
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            tokenId: token.tokenId,
            status: input.status,
            floorWei: pricing.floorWei,
            ceilingWei: pricing.ceilingWei,
            deltaWei: pricing.deltaWei,
            priceTierId: pricing.priceTierId,
            pricingSource: pricing.pricingSource,
        };
        // Persist the desired job state and enqueue the matching Outbox command.
        const result = this.biddingJobsRepositoryPort.upsertTokenJob(
            persistedInput,
        );
        // Publish a post-commit wake-up so the running bot scans the durable command rows immediately.
        this.tradingJobCommandSignalPort.publishBiddingJobCommandsChanged(
            result.commands,
        );

        return {
            chain,
            collection,
            tokenId: token.tokenId,
            job: mapPersistedTokenBiddingJobToView(result.job),
        };
    }
}
