import {
    TRADING_BIDDING_BID_SCOPE_KIND,
    type TradingBiddingBidScopeKind,
    type TradingTraitCriterion,
} from "../types/trading.js";

// The same target must group together for state filtering and rendered demand buckets.
export type BiddingBidBookGroupScope = {
    kind: TradingBiddingBidScopeKind;
    label: string;
    tokenId: string | null;
    traits: readonly TradingTraitCriterion[];
};

export function canonicalBiddingBidBookTraits(
    traits: readonly TradingTraitCriterion[],
): TradingTraitCriterion[] {
    return [...traits].sort((left, right) => {
        const typeCompare = left.type.localeCompare(right.type);
        return typeCompare === 0
            ? left.value.localeCompare(right.value)
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
        return JSON.stringify(
            canonicalBiddingBidBookTraits(scope.traits).map((trait) => [
                trait.type,
                trait.value,
            ]),
        );
    }
    return JSON.stringify([scope.kind, scope.label, scope.tokenId ?? ""]);
}
