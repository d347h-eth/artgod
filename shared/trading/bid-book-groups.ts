import {
    TRADING_BIDDING_BID_SCOPE_KIND,
    type TradingBiddingBidScopeKind,
    formatTradingTraitCriterionLabel,
    type TradingBiddingTraitCriterion,
} from "../types/trading.js";
import { biddingTraitCriteriaKey } from "./offer-trait-criteria.js";

// The same target must group together for state filtering and rendered demand buckets.
export type BiddingBidBookGroupScope = {
    kind: TradingBiddingBidScopeKind;
    label: string;
    tokenId: string | null;
    traits: readonly TradingBiddingTraitCriterion[];
};

export function canonicalBiddingBidBookTraits(
    traits: readonly TradingBiddingTraitCriterion[],
): TradingBiddingTraitCriterion[] {
    return [...traits].sort((left, right) => {
        const typeCompare = left.type.localeCompare(right.type);
        return typeCompare === 0
            ? formatTradingTraitCriterionLabel(left).localeCompare(
                  formatTradingTraitCriterionLabel(right),
              )
            : typeCompare;
    });
}

// Token IDs and complete trait combinations identify groups independently of
// display labels or criterion order. JSON preserves boundaries in untrusted trait text.
export function biddingBidBookGroupKey(
    scope: BiddingBidBookGroupScope,
): string {
    if (
        scope.kind === TRADING_BIDDING_BID_SCOPE_KIND.Token &&
        scope.tokenId !== null
    ) {
        return JSON.stringify([scope.kind, scope.tokenId]);
    }
    if (scope.traits.length > 0) {
        return biddingTraitCriteriaKey(scope.traits);
    }
    return JSON.stringify([scope.kind, scope.label, scope.tokenId ?? ""]);
}
