import type { ChainRecord, CollectionListItem } from "@artgod/shared/types";
import type {
    BiddingJobsRepositoryPort,
    UpsertCollectionBiddingJobInput as PersistedUpsertCollectionBiddingJobInput,
} from "./ports.js";
import {
    resolveBiddingJobPricing,
    type BiddingJobPriceTierReadPort,
} from "./bidding-job-pricing.js";
import type { UpsertCollectionBiddingJobOutput } from "./types.js";
import {
    mapPersistedBiddingJobToView,
    TradingValidationError,
    type BiddingJobMutationStatus,
} from "./types.js";
import type { TradingJobCommandSignalPort } from "./trading-job-command-signal-port.js";
export type { UpsertCollectionBiddingJobOutput } from "./types.js";

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

export class UpsertCollectionBiddingJobUseCase {
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
            "upsertCollectionJob"
        >,
        readonly biddingPriceTiersRepositoryPort: BiddingJobPriceTierReadPort,
        readonly tradingJobCommandSignalPort: TradingJobCommandSignalPort,
    ) {}

    upsertCollectionBiddingJob(
        input: UpsertCollectionBiddingJobInput,
    ): UpsertCollectionBiddingJobOutput {
        // Resolve the requested chain against the configured backend default.
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        // Resolve the collection before mutating its collection-wide bidding job.
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

        const persistedInput: PersistedUpsertCollectionBiddingJobInput = {
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            status: input.status,
            floorWei: pricing.floorWei,
            ceilingWei: pricing.ceilingWei,
            deltaWei: pricing.deltaWei,
            priceTierId: pricing.priceTierId,
            pricingSource: pricing.pricingSource,
            quantity: parseQuantity(input.quantity),
            targetTraits: [],
        };
        // Persist the desired collection job and enqueue the matching Outbox command.
        const result = this.biddingJobsRepositoryPort.upsertCollectionJob(
            persistedInput,
        );
        // Publish a post-commit wake-up so the running bot scans the durable command rows immediately.
        this.tradingJobCommandSignalPort.publishBiddingJobCommandsChanged(
            result.commands,
        );

        return {
            chain,
            collection,
            job: mapPersistedBiddingJobToView(result.job),
        };
    }
}

function parseQuantity(value: number | undefined): number {
    if (value === undefined) {
        return 1;
    }
    if (!Number.isInteger(value) || value <= 0) {
        throw new TradingValidationError("quantity must be an integer > 0");
    }
    return value;
}
