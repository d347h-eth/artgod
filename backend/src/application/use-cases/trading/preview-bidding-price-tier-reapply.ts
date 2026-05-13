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

export type PreviewBiddingPriceTierReapplyInput = {
    chainRef: string;
    collectionRef: string;
    tierId: string;
};

export type PreviewBiddingPriceTierReapplyOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    tier: BiddingPriceTierView;
    jobs: BiddingPriceTierReapplyJobPreview[];
};

export class PreviewBiddingPriceTierReapplyUseCase {
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
        readonly biddingPriceTiersRepositoryPort: Pick<
            BiddingPriceTiersRepositoryPort,
            "listCollectionPriceTiers"
        >,
    ) {}

    previewBiddingPriceTierReapply(
        input: PreviewBiddingPriceTierReapplyInput,
    ): PreviewBiddingPriceTierReapplyOutput {
        // Resolve the requested chain against the configured backend default.
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        // Resolve the collection before reading its tier-backed jobs.
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
        // Load declared jobs so the preview is based on authoritative DB state.
        const jobs = this.biddingJobsRepositoryPort.listCollectionJobs({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
        });
        const plan = buildBiddingPriceTierReapplyPlan({
            tierId: input.tierId,
            jobs,
            tiers,
        });

        return {
            chain,
            collection,
            tier: plan.tier,
            jobs: plan.jobs.map(toPublicBiddingPriceTierReapplyJobPreview),
        };
    }
}
