import { formatEther } from "viem";
import type {
    ChainRecord,
    CollectionListItem,
    TokenCard,
    TraitFacet,
    TraitFilter,
    TraitRangeFilter,
} from "@artgod/shared/types/browse";
import type {
    TradingBiddingBidBookSource,
    TradingBiddingBidScopeKind,
    TradingTraitCriterion,
} from "@artgod/shared/types";

export const COLLECTION_BIDDING_BID_SCOPE_FILTER = {
    Token: "token",
    Traits: "traits",
    Collection: "collection",
} as const;

export const COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE = {
    Or: "or",
    And: "and",
} as const;

export type CollectionBiddingBidScopeFilter =
    (typeof COLLECTION_BIDDING_BID_SCOPE_FILTER)[keyof typeof COLLECTION_BIDDING_BID_SCOPE_FILTER];

export type CollectionBiddingTraitFilterJoinMode =
    (typeof COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE)[keyof typeof COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE];

export type PersistedBiddingBidBookRow = {
    orderId: string;
    source: TradingBiddingBidBookSource;
    scopeKind: TradingBiddingBidScopeKind;
    scopeLabel: string;
    tokenId: string | null;
    scopeTraits: TradingTraitCriterion[];
    encodedTokenIds: string | null;
    maker: string;
    isOwn: boolean;
    priceWei: string;
    quantity: string;
    currencyAddress: string | null;
    currencySymbol: string | null;
    protocolAddress: string | null;
    validUntil: number | null;
    placedAt: string | null;
    snapshotRefreshedAtMs: number | null;
    seenAt: string | null;
};

export type PersistedBiddingBidBookState = {
    source: TradingBiddingBidBookSource;
    updatedAt: string | null;
    snapshotRefreshedAtMs: number | null;
    projectedAt: string | null;
    rowCount: number;
    durationMs: number | null;
    lastError: string | null;
};

export type PersistedBiddingBidBook = {
    state: PersistedBiddingBidBookState;
    bids: PersistedBiddingBidBookRow[];
};

export interface BiddingBidBookRepositoryPort {
    listCollectionBidBook(params: {
        chainId: number;
        collectionId: number;
        scopeFilter: CollectionBiddingBidScopeFilter;
        traitFilterJoinMode: CollectionBiddingTraitFilterJoinMode;
        selectedTraits: TraitFilter[];
        selectedTraitRanges: TraitRangeFilter[];
    }): PersistedBiddingBidBook;
    listTokenBidBook(params: {
        chainId: number;
        collectionId: number;
        tokenId: string;
        tokenTraits: TradingTraitCriterion[];
    }): PersistedBiddingBidBook;
}

export type BiddingBidBookRowView = {
    orderId: string;
    source: TradingBiddingBidBookSource;
    scope: {
        kind: TradingBiddingBidScopeKind;
        label: string;
        tokenId: string | null;
        traits: TradingTraitCriterion[];
    };
    maker: {
        address: string;
        label: string;
        isOwn: boolean;
    };
    priceWei: string;
    priceEth: string;
    quantity: string;
    currencyAddress: string | null;
    currencySymbol: string | null;
    protocolAddress: string | null;
    validUntil: number | null;
    placedAt: string | null;
    snapshotRefreshedAtMs: number | null;
    seenAt: string | null;
};

export type BiddingBidBookView = {
    state: PersistedBiddingBidBookState;
    bids: BiddingBidBookRowView[];
};

export type BiddingTokenOfferCardView = TokenCard & {
    offers: BiddingBidBookRowView[];
};

export type BiddingTokenOfferCardsPage = {
    items: BiddingTokenOfferCardView[];
    prevCursor: string | null;
    nextCursor: string | null;
    limit: number;
    totalItems: number;
    totalOffers: number;
    rangeStart: number;
    rangeEnd: number;
    currentPage: number;
    totalPages: number;
};

export type ListCollectionBiddingBidBookOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    scopeFilter: CollectionBiddingBidScopeFilter;
    traits: {
        selected: TraitFilter[];
        selectedRanges: TraitRangeFilter[];
        facets: TraitFacet[];
    };
    bidBook: BiddingBidBookView;
    tokenOfferCards: BiddingTokenOfferCardsPage;
};

export type GetTokenBiddingBidBookOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    tokenId: string;
    bidBook: BiddingBidBookView;
};

export function mapPersistedBidBookToView(
    bidBook: PersistedBiddingBidBook,
): BiddingBidBookView {
    return {
        state: bidBook.state,
        bids: mapPersistedBidRowsToView(bidBook.bids),
    };
}

export function mapPersistedBidRowsToView(
    bids: PersistedBiddingBidBookRow[],
): BiddingBidBookRowView[] {
    return bids.map((bid) => ({
        orderId: bid.orderId,
        source: bid.source,
        scope: {
            kind: bid.scopeKind,
            label: bid.scopeLabel,
            tokenId: bid.tokenId,
            traits: bid.scopeTraits,
        },
        maker: {
            address: bid.maker,
            label: bid.isOwn ? "You" : bid.maker,
            isOwn: bid.isOwn,
        },
        priceWei: bid.priceWei,
        priceEth: formatEther(BigInt(bid.priceWei)),
        quantity: bid.quantity,
        currencyAddress: bid.currencyAddress,
        currencySymbol: bid.currencySymbol,
        protocolAddress: bid.protocolAddress,
        validUntil: bid.validUntil,
        placedAt: bid.placedAt,
        snapshotRefreshedAtMs: bid.snapshotRefreshedAtMs,
        seenAt: bid.seenAt,
    }));
}
