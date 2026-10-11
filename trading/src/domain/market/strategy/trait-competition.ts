import type { TraitTarget, TraitSelector } from "./job.js";
import type { TradingBiddingTraitCriterion } from "@artgod/shared/types";
import {
    biddingTraitsMatchToken,
    biddingTraitValueMatches,
    biddingTraitCriteriaKey,
} from "@artgod/shared/trading/offer-trait-criteria";

// Broader trait offers compete for every NFT in the job's AND target. Keep this
// policy separate from exact target equality used to manage the maker's orders.
export function matchesTraitCompetition(
    criteria: readonly TradingBiddingTraitCriterion[],
    target: readonly TraitTarget[],
    extras: readonly TraitSelector[] = [],
): boolean {
    if (target.length === 0 || criteria.length === 0) return false;
    if (biddingTraitsMatchToken(criteria, target)) return true;

    // Extra selectors include standalone buckets only. Repeated copies of the
    // same criterion do not turn a single-trait offer into a multi-trait offer.
    const first = criteria[0];
    return (
        criteria.every(
            (trait) =>
                biddingTraitCriteriaKey([trait]) ===
                biddingTraitCriteriaKey([first]),
        ) &&
        extras.some(
            (selector) =>
                selector.type === first.type &&
                (selector.value === undefined ||
                    biddingTraitValueMatches(first, selector.value)),
        )
    );
}
