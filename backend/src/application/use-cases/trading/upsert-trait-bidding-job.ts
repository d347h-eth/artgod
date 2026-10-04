import type {
    ChainRecord,
    CollectionListItem,
    TradingTraitCriterion,
} from "@artgod/shared/types";
import {
    normalizeTraitBiddingTarget,
    TraitCompetitionValidationError,
} from "@artgod/shared/trading/trait-competition";
import type {
    BiddingJobsRepositoryPort,
    UpsertCollectionBiddingJobInput as PersistedUpsertCollectionBiddingJobInput,
} from "./ports.js";
import {
    resolveBiddingJobPricing,
    type BiddingJobPriceTierReadPort,
} from "./bidding-job-pricing.js";
import type { UpsertTraitBiddingJobOutput } from "./types.js";
import {
    mapPersistedBiddingJobToView,
    TradingValidationError,
    type BiddingJobMutationStatus,
} from "./types.js";
import type { TradingJobCommandSignalPort } from "./trading-job-command-signal-port.js";
export type { UpsertTraitBiddingJobOutput } from "./types.js";

import {
    assertMarketplaceBiddingSupportedTargetTraits,
    type TraitBiddingTargetSupportReadPort,
} from "./trait-bidding-target.js";
export type { TraitBiddingTargetSupportReadPort } from "./trait-bidding-target.js";

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
    competitionPresetVersionId?: string | null;
};

export class UpsertTraitBiddingJobUseCase {
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
        readonly traitBiddingTargetSupportReadPort: TraitBiddingTargetSupportReadPort,
        readonly biddingJobsRepositoryPort: Pick<
            BiddingJobsRepositoryPort,
            "upsertCollectionJob"
        >,
        readonly biddingPriceTiersRepositoryPort: BiddingJobPriceTierReadPort,
        readonly tradingJobCommandSignalPort: TradingJobCommandSignalPort,
    ) {}

    upsertTraitBiddingJob(
        input: UpsertTraitBiddingJobInput,
    ): UpsertTraitBiddingJobOutput {
        // Resolve the requested chain against the configured backend default.
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        // Resolve the collection before mutating its criteria-scoped bidding job.
        const collection = this.collectionReadPort.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );
        let targetTraits: TradingTraitCriterion[];
        try {
            targetTraits = normalizeTraitBiddingTarget(input.targetTraits);
        } catch (error) {
            if (error instanceof TraitCompetitionValidationError) {
                throw new TradingValidationError(error.message);
            }
            throw error;
        }
        assertMarketplaceBiddingSupportedTargetTraits({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            targetTraits,
            traitBiddingTargetSupportReadPort:
                this.traitBiddingTargetSupportReadPort,
        });

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
            targetTraits,
            competitionPresetVersionId: input.competitionPresetVersionId,
        };
        // Persist the desired trait job and enqueue the matching Outbox command.
        const result =
            this.biddingJobsRepositoryPort.upsertCollectionJob(persistedInput);
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
