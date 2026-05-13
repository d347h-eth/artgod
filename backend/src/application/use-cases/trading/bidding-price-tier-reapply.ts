import { formatEther } from "viem";
import {
    TRADING_BIDDING_JOB_PRICING_SOURCE_KIND,
    type PersistedBiddingJobRecord,
    type PersistedBiddingPriceTierRecord,
    type TradingBiddingJobPricingSource,
} from "@artgod/shared/types";
import {
    mapResolvedBiddingPriceTierToView,
    resolveBiddingPriceTierGraph,
    type BiddingPriceTierView,
} from "./bidding-price-tiers.js";
import { mapPersistedBiddingJobToView, type BiddingJobView } from "./types.js";

export type BiddingPriceTierReapplyPricePreview = {
    floorEth: string;
    ceilingEth: string;
    deltaEth: string;
    pricingSource: TradingBiddingJobPricingSource | null;
};

export type BiddingPriceTierReapplyJobPreview = {
    job: BiddingJobView;
    before: BiddingPriceTierReapplyPricePreview;
    after: BiddingPriceTierReapplyPricePreview;
    changed: boolean;
};

export type BiddingPriceTierReapplyJobPlan = BiddingPriceTierReapplyJobPreview & {
    persistedJob: PersistedBiddingJobRecord;
    afterWei: {
        floorWei: string;
        ceilingWei: string;
        deltaWei: string;
        priceTierId: string;
        pricingSource: TradingBiddingJobPricingSource;
    };
};

export type BiddingPriceTierReapplyPlan = {
    tier: BiddingPriceTierView;
    jobs: BiddingPriceTierReapplyJobPlan[];
};

// Builds the backend-owned staged tier reapply diff for all active jobs linked to one tier.
export function buildBiddingPriceTierReapplyPlan(params: {
    tierId: string;
    jobs: PersistedBiddingJobRecord[];
    tiers: PersistedBiddingPriceTierRecord[];
}): BiddingPriceTierReapplyPlan {
    const resolvedTier = resolveBiddingPriceTierGraph(params.tiers).find(
        (tier) => tier.tierId === params.tierId,
    );
    if (!resolvedTier) {
        throw new Error(`price tier ${params.tierId} was not found`);
    }

    const tierView = mapResolvedBiddingPriceTierToView(resolvedTier);
    const jobs = params.jobs
        .filter((job) => job.priceTierId === resolvedTier.tierId)
        .map((job) => {
            const pricingSource: TradingBiddingJobPricingSource = {
                kind: TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.PriceTier,
                tierId: resolvedTier.tierId,
                tierName: resolvedTier.name,
                resolvedAt: resolvedTier.resolvedAt,
                resolvedFloorWei: resolvedTier.resolvedFloorWei,
                resolvedCeilingWei: resolvedTier.resolvedCeilingWei,
                deltaWei: resolvedTier.deltaWei,
            };
            const before = {
                floorEth: formatWeiAsEth(job.floorWei),
                ceilingEth: formatWeiAsEth(job.ceilingWei),
                deltaEth: formatWeiAsEth(job.deltaWei),
                pricingSource: job.pricingSource,
            };
            const after = {
                floorEth: formatWeiAsEth(resolvedTier.resolvedFloorWei),
                ceilingEth: formatWeiAsEth(resolvedTier.resolvedCeilingWei),
                deltaEth: formatWeiAsEth(resolvedTier.deltaWei),
                pricingSource,
            };
            return {
                job: mapPersistedBiddingJobToView(job),
                persistedJob: job,
                before,
                after,
                afterWei: {
                    floorWei: resolvedTier.resolvedFloorWei,
                    ceilingWei: resolvedTier.resolvedCeilingWei,
                    deltaWei: resolvedTier.deltaWei,
                    priceTierId: resolvedTier.tierId,
                    pricingSource,
                },
                changed: isPricePreviewChanged(before, after),
            };
        });

    return {
        tier: tierView,
        jobs,
    };
}

export function toPublicBiddingPriceTierReapplyJobPreview(
    plan: BiddingPriceTierReapplyJobPlan,
): BiddingPriceTierReapplyJobPreview {
    return {
        job: plan.job,
        before: plan.before,
        after: plan.after,
        changed: plan.changed,
    };
}

function isPricePreviewChanged(
    before: BiddingPriceTierReapplyPricePreview,
    after: BiddingPriceTierReapplyPricePreview,
): boolean {
    return (
        before.floorEth !== after.floorEth ||
        before.ceilingEth !== after.ceilingEth ||
        before.deltaEth !== after.deltaEth ||
        JSON.stringify(before.pricingSource) !== JSON.stringify(after.pricingSource)
    );
}

function formatWeiAsEth(value: string): string {
    return formatEther(BigInt(value));
}
