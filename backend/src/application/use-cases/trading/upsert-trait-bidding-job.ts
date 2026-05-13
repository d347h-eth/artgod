import type { ChainRecord, CollectionListItem, TradingTraitCriterion } from "@artgod/shared/types";
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
            targetTraits: normalizeTargetTraits(input.targetTraits),
        };
        // Persist the desired trait job and enqueue the matching Outbox command.
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

function normalizeTargetTraits(
    traits: TradingTraitCriterion[],
): TradingTraitCriterion[] {
    if (traits.length === 0) {
        throw new TradingValidationError("targetTraits is required");
    }

    const seen = new Set<string>();
    return traits
        .map((trait) => ({
            type: normalizeTraitPart(trait.type, "targetTraits.type"),
            value: normalizeTraitPart(trait.value, "targetTraits.value"),
        }))
        .sort(compareTraits)
        .map((trait) => {
            const key = `${trait.type}\u0000${trait.value}`;
            if (seen.has(key)) {
                throw new TradingValidationError(
                    `duplicate target trait ${trait.type}=${trait.value}`,
                );
            }
            seen.add(key);
            return trait;
        });
}

function normalizeTraitPart(value: string, field: string): string {
    const normalized = value.trim();
    if (!normalized) {
        throw new TradingValidationError(`${field} is required`);
    }
    return normalized;
}

function compareTraits(
    left: TradingTraitCriterion,
    right: TradingTraitCriterion,
): number {
    const typeCompare = left.type.localeCompare(right.type);
    return typeCompare === 0 ? left.value.localeCompare(right.value) : typeCompare;
}
