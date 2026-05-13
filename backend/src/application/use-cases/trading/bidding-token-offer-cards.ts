import {
    renderTraitSummaryTemplate,
    TRADING_BIDDING_BID_SCOPE_KIND,
    type TokenAttribute,
    type TokenCard,
} from "@artgod/shared/types";
import type { TraitFilter, TraitRangeFilter } from "@artgod/shared/types/browse";
import type { PersistedBiddingBidBookRow } from "./bidding-bid-book.js";
import {
    COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
    type CollectionBiddingTraitFilterJoinMode,
} from "./bidding-bid-book.js";

export type PersistedTokenOfferCard = {
    token: TokenCard;
    persistedOffers: PersistedBiddingBidBookRow[];
};

// Groups token-scoped offers after applying the same low-signal floor used by the offers UI.
export function buildTokenOfferGroups(params: {
    tokenBids: PersistedBiddingBidBookRow[];
    collectionBids: PersistedBiddingBidBookRow[];
}): Map<string, PersistedBiddingBidBookRow[]> {
    return groupTokenOffers(params.tokenBids, topBidPriceWei(params.collectionBids));
}

// Orders token IDs by their highest surviving token-scoped offer.
export function sortTokenIdsByTopOffer(
    offersByTokenId: Map<string, PersistedBiddingBidBookRow[]>,
): string[] {
    return [...offersByTokenId.entries()]
        .sort((left, right) => {
            const leftTop = topOfferPrice(left[1]);
            const rightTop = topOfferPrice(right[1]);
            if (leftTop === rightTop) {
                return left[0].localeCompare(right[0], undefined, {
                    numeric: true,
                });
            }
            return leftTop > rightTop ? -1 : 1;
        })
        .map(([tokenId]) => tokenId);
}

// Builds reusable token-offer cards from hydrated tokens and grouped bid rows.
export function buildPersistedTokenOfferCards(params: {
    tokenCards: TokenCard[];
    offersByTokenId: Map<string, PersistedBiddingBidBookRow[]>;
    selectedTraits: TraitFilter[];
    selectedTraitRanges: TraitRangeFilter[];
    traitSummaryTemplate?: string | null;
}): PersistedTokenOfferCard[] {
    return params.tokenCards.flatMap((token) => {
        const offers = params.offersByTokenId.get(token.tokenId) ?? [];
        if (
            offers.length === 0 ||
            !tokenMatchesTraitFilters(
                token,
                params.selectedTraits,
                params.selectedTraitRanges,
            )
        ) {
            return [];
        }
        return [
            {
                token:
                    params.traitSummaryTemplate === undefined
                        ? token
                        : {
                              ...token,
                              traitSummary: renderTraitSummaryTemplate(
                                  params.traitSummaryTemplate ?? "",
                                  token.attributes,
                              ),
                          },
                persistedOffers: offers,
            },
        ];
    });
}

// Applies token-card trait filters with token-browser semantics: OR within one key, AND across keys.
export function tokenMatchesTraitFilters(
    token: Pick<TokenCard, "attributes">,
    selectedTraits: TraitFilter[],
    selectedTraitRanges: TraitRangeFilter[],
): boolean {
    return tokenMatchesTraitFiltersWithJoinMode(
        token,
        selectedTraits,
        selectedTraitRanges,
        COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And,
    );
}

// Applies token-card trait filters using the requested offers-page join semantics.
export function tokenMatchesTraitFiltersWithJoinMode(
    token: Pick<TokenCard, "attributes">,
    selectedTraits: TraitFilter[],
    selectedTraitRanges: TraitRangeFilter[],
    traitJoinMode: CollectionBiddingTraitFilterJoinMode,
): boolean {
    if (traitJoinMode === COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or) {
        return tokenMatchesAnyTraitFilter(
            token.attributes,
            selectedTraits,
            selectedTraitRanges,
        );
    }
    return (
        tokenMatchesExactTraitFilters(token.attributes, selectedTraits) &&
        tokenMatchesRangeTraitFilters(token.attributes, selectedTraitRanges)
    );
}

function tokenMatchesAnyTraitFilter(
    attributes: TokenAttribute[],
    selectedTraits: TraitFilter[],
    selectedTraitRanges: TraitRangeFilter[],
): boolean {
    if (selectedTraits.length === 0 && selectedTraitRanges.length === 0) {
        return true;
    }
    return (
        selectedTraits.some((trait) =>
            attributes.some(
                (attribute) =>
                    attribute.key === trait.key &&
                    attribute.value === trait.value,
            ),
        ) ||
        selectedTraitRanges.some((range) =>
            attributes.some(
                (attribute) =>
                    attribute.key === range.key &&
                    traitValueWithinRange(attribute.value, range),
            ),
        )
    );
}

function groupTokenOffers(
    bids: PersistedBiddingBidBookRow[],
    topCollectionBidWei: bigint | null,
): Map<string, PersistedBiddingBidBookRow[]> {
    const grouped = new Map<string, PersistedBiddingBidBookRow[]>();
    for (const bid of bids) {
        if (
            bid.scopeKind !== TRADING_BIDDING_BID_SCOPE_KIND.Token ||
            !bid.tokenId ||
            !tokenOfferPassesCollectionBidFloor(bid, topCollectionBidWei)
        ) {
            continue;
        }
        const offers = grouped.get(bid.tokenId) ?? [];
        offers.push(bid);
        grouped.set(bid.tokenId, offers);
    }

    for (const [tokenId, offers] of grouped) {
        grouped.set(tokenId, sortOffersByPriceDesc(offers));
    }
    return grouped;
}

function tokenOfferPassesCollectionBidFloor(
    bid: PersistedBiddingBidBookRow,
    topCollectionBidWei: bigint | null,
): boolean {
    if (topCollectionBidWei === null || topCollectionBidWei <= 0n) {
        return true;
    }
    return BigInt(bid.priceWei) * 10n >= topCollectionBidWei;
}

function topBidPriceWei(bids: PersistedBiddingBidBookRow[]): bigint | null {
    let top: bigint | null = null;
    for (const bid of bids) {
        const price = BigInt(bid.priceWei);
        if (top === null || price > top) {
            top = price;
        }
    }
    return top;
}

function topOfferPrice(offers: PersistedBiddingBidBookRow[]): bigint {
    return offers.length === 0 ? 0n : BigInt(offers[0].priceWei);
}

function sortOffersByPriceDesc(
    offers: PersistedBiddingBidBookRow[],
): PersistedBiddingBidBookRow[] {
    return [...offers].sort((left, right) => {
        const leftPrice = BigInt(left.priceWei);
        const rightPrice = BigInt(right.priceWei);
        if (leftPrice === rightPrice) {
            return left.orderId.localeCompare(right.orderId);
        }
        return leftPrice > rightPrice ? -1 : 1;
    });
}

function tokenMatchesExactTraitFilters(
    attributes: TokenAttribute[],
    selectedTraits: TraitFilter[],
): boolean {
    const selectedByKey = new Map<string, Set<string>>();
    for (const trait of selectedTraits) {
        const values = selectedByKey.get(trait.key) ?? new Set<string>();
        values.add(trait.value);
        selectedByKey.set(trait.key, values);
    }

    for (const [key, values] of selectedByKey) {
        const hasMatch = attributes.some(
            (attribute) => attribute.key === key && values.has(attribute.value),
        );
        if (!hasMatch) {
            return false;
        }
    }
    return true;
}

function tokenMatchesRangeTraitFilters(
    attributes: TokenAttribute[],
    selectedTraitRanges: TraitRangeFilter[],
): boolean {
    return selectedTraitRanges.every((range) =>
        attributes.some(
            (attribute) =>
                attribute.key === range.key &&
                traitValueWithinRange(attribute.value, range),
        ),
    );
}

function traitValueWithinRange(value: string, range: TraitRangeFilter): boolean {
    if (!/^\d+$/.test(value)) {
        return false;
    }
    const numeric = BigInt(value);
    if (range.fromValue !== null && numeric < BigInt(range.fromValue)) {
        return false;
    }
    if (range.toValue !== null && numeric > BigInt(range.toValue)) {
        return false;
    }
    return true;
}
