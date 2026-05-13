import type { ChainRecord, CollectionListItem } from "@artgod/shared/types";
import { ReadModelNotFoundError } from "@artgod/shared/read-models/errors";
import type { BiddingPriceTiersRepositoryPort } from "./bidding-price-tier-ports.js";
import type { BiddingJobsRepositoryPort } from "./ports.js";
import {
    buildBiddingPriceTierReapplyPlan,
    toPublicBiddingPriceTierReapplyJobPreview,
    type BiddingPriceTierReapplyJobPreview,
} from "./bidding-price-tier-reapply.js";
import type { BiddingPriceTierView } from "./bidding-price-tiers.js";
import { mapPersistedBiddingJobToView, TradingValidationError, type BiddingJobView } from "./types.js";
import type { TradingJobCommandSignalPort } from "./trading-job-command-signal-port.js";

export type ApplyBiddingPriceTierReapplyInput = {
    chainRef: string;
    collectionRef: string;
    tierId: string;
    jobIds: string[];
};

export type ApplyBiddingPriceTierReapplyOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    tier: BiddingPriceTierView;
    jobs: BiddingJobView[];
    preview: BiddingPriceTierReapplyJobPreview[];
};

export class ApplyBiddingPriceTierReapplyUseCase {
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
            "listCollectionJobs" | "updateJobsPricingById"
        >,
        readonly biddingPriceTiersRepositoryPort: Pick<
            BiddingPriceTiersRepositoryPort,
            "listCollectionPriceTiers"
        >,
        readonly tradingJobCommandSignalPort: TradingJobCommandSignalPort,
    ) {}

    applyBiddingPriceTierReapply(
        input: ApplyBiddingPriceTierReapplyInput,
    ): ApplyBiddingPriceTierReapplyOutput {
        if (input.jobIds.length === 0) {
            throw new TradingValidationError("jobIds is required");
        }

        // Resolve the requested chain against the configured backend default.
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        // Resolve the collection before updating tier-backed jobs scoped to it.
        const collection = this.collectionReadPort.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );
        // Load current active tiers for backend-owned graph resolution.
        const tiers = this.biddingPriceTiersRepositoryPort.listCollectionPriceTiers({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
        });
        if (!tiers.some((tier) => tier.tierId === input.tierId)) {
            throw new ReadModelNotFoundError("Unknown bidding price tier");
        }
        // Load declared jobs so selected job ids can be validated against current tier ownership.
        const jobs = this.biddingJobsRepositoryPort.listCollectionJobs({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
        });
        const plan = buildBiddingPriceTierReapplyPlan({
            tierId: input.tierId,
            jobs,
            tiers,
        });
        const selectedIds = new Set(input.jobIds);
        const selectedPlans = plan.jobs.filter((job) => selectedIds.has(job.job.jobId));
        if (selectedPlans.length !== selectedIds.size) {
            throw new TradingValidationError("jobIds must reference tier-backed jobs");
        }

        // Persist selected changed jobs and enqueue normal job update commands atomically.
        const result = this.biddingJobsRepositoryPort.updateJobsPricingById(
            selectedPlans
                .filter((job) => job.changed)
                .map((job) => ({
                    chainId: chain.publicChainId,
                    collectionId: collection.collectionId,
                    jobId: job.job.jobId,
                    ...job.afterWei,
                })),
        );
        // Publish a post-commit wake-up so the running bot scans the durable update commands immediately.
        this.tradingJobCommandSignalPort.publishBiddingJobCommandsChanged(
            result.commands,
        );

        return {
            chain,
            collection,
            tier: plan.tier,
            jobs: result.jobs.map(mapPersistedBiddingJobToView),
            preview: selectedPlans.map(toPublicBiddingPriceTierReapplyJobPreview),
        };
    }
}
