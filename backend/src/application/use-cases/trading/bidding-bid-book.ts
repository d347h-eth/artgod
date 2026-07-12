import { formatEther } from "viem";
import type {
    ChainRecord,
    CollectionMediaState,
    CollectionListItem,
    TokenCard,
    TraitFacet,
    TraitFilter,
    TraitRangeFilter,
} from "@artgod/shared/types/browse";
import type {
    TradingBiddingBidBookSource,
    TradingBiddingBidBookOwnJobPhase,
    TradingBiddingAuthorization,
    TradingBiddingBidScopeKind,
    TradingBiddingJobRuntimeBidPosition,
    TradingBiddingJobRuntimeConstraint,
    TradingBotLifecycleStatus,
    TradingJobStatus,
    TradingTraitCriterion,
    CollectionBiddingBidScopeFilter,
    CollectionBiddingTraitFilterJoinMode,
} from "@artgod/shared/types";
import {
    TRADING_BIDDING_BID_BOOK_PRICE_KIND,
    TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND,
} from "@artgod/shared/types";

export {
    COLLECTION_BIDDING_BID_SCOPE_FILTER,
    COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
} from "@artgod/shared/types";
export type {
    CollectionBiddingBidScopeFilter,
    CollectionBiddingTraitFilterJoinMode,
} from "@artgod/shared/types";

export type PersistedBiddingBidBookRow = {
    orderId: string;
    source: TradingBiddingBidBookSource;
    materialization: BiddingBidBookRowMaterialization;
    scopeKind: TradingBiddingBidScopeKind;
    scopeLabel: string;
    tokenId: string | null;
    scopeTraits: TradingTraitCriterion[];
    encodedTokenIds: string | null;
    maker: string;
    isOwn: boolean;
    price: BiddingBidBookRowPrice;
    bidLimits: BiddingBidBookBidLimits | null;
    quantity: string;
    currencyAddress: string | null;
    currencySymbol: string | null;
    protocolAddress: string | null;
    validUntil: number | null;
    placedAt: string | null;
    snapshotRefreshedAtMs: number | null;
    seenAt: string | null;
    ownStatus: BiddingBidBookOwnStatus | null;
};

export type BiddingBidBookRowMaterialization =
    | {
          kind: typeof TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.MarketBid;
          jobId: null;
          status: null;
          phase: null;
      }
    | {
          kind: typeof TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent;
          jobId: string;
          status: TradingJobStatus;
          phase: TradingBiddingBidBookOwnJobPhase;
      };

export type BiddingBidBookRowPrice =
    | {
          kind: typeof TRADING_BIDDING_BID_BOOK_PRICE_KIND.Exact;
          wei: string;
          eth: string;
      }
    | {
          kind: typeof TRADING_BIDDING_BID_BOOK_PRICE_KIND.Range;
          floorWei: string;
          floorEth: string;
          ceilingWei: string;
          ceilingEth: string;
      };

export type BiddingBidBookBidLimits = {
    floorWei: string;
    floorEth: string;
    ceilingWei: string;
    ceilingEth: string;
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

// Describes the bot-owned market rank for an own bid row.
export type BiddingBidBookOwnPosition = TradingBiddingJobRuntimeBidPosition;

// Names compact bot-owned strategy limits that can be rendered directly in rows.
export type BiddingBidBookOwnConstraint = TradingBiddingJobRuntimeConstraint;

// Carries bot-decision-backed own-bid signals so the frontend does not reimplement bot rules.
export type BiddingBidBookOwnStatus = {
    position: BiddingBidBookOwnPosition;
    constraints: BiddingBidBookOwnConstraint[];
    job: {
        jobId: string;
        revision: number;
        status: TradingJobStatus;
    } | null;
};

export type PersistedBiddingBidBook = {
    state: PersistedBiddingBidBookState;
    biddingBotStatus: TradingBotLifecycleStatus;
    biddingAuthorization: TradingBiddingAuthorization | null;
    ownMakerAddress: string | null;
    bids: PersistedBiddingBidBookRow[];
};

export interface BiddingBidBookRepositoryPort {
    listCollectionBidBook(params: {
        chainId: number;
        collectionId: number;
        includeOwnJobContext: boolean;
        scopeFilter: CollectionBiddingBidScopeFilter;
        traitFilterJoinMode: CollectionBiddingTraitFilterJoinMode;
        selectedTraits: TraitFilter[];
        selectedTraitRanges: TraitRangeFilter[];
        makerAddress?: string | null;
    }): PersistedBiddingBidBook;
    listTokenBidBook(params: {
        chainId: number;
        collectionId: number;
        tokenId: string;
        tokenTraits: TradingTraitCriterion[];
        includeOwnJobContext: boolean;
    }): PersistedBiddingBidBook;
}

export type BiddingBidBookRowView = {
    orderId: string;
    source: TradingBiddingBidBookSource;
    materialization: BiddingBidBookRowMaterialization;
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
    price: BiddingBidBookRowPrice;
    bidLimits: BiddingBidBookBidLimits | null;
    quantity: string;
    currencyAddress: string | null;
    currencySymbol: string | null;
    protocolAddress: string | null;
    validUntil: number | null;
    placedAt: string | null;
    snapshotRefreshedAtMs: number | null;
    seenAt: string | null;
    ownStatus: BiddingBidBookOwnStatus | null;
};

export type BiddingBidBookView = {
    state: PersistedBiddingBidBookState;
    biddingBotStatus: TradingBotLifecycleStatus;
    biddingAuthorization: BiddingAuthorizationView | null;
    ownMakerAddress: string | null;
    bids: BiddingBidBookRowView[];
};

// Presents approved bidding limits in both storage and user-facing units.
export type BiddingAuthorizationView = TradingBiddingAuthorization & {
    maxUnitBidEth: string | null;
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
    marketplaceBiddingSupportedTotalItems: number;
    totalOffers: number;
    rangeStart: number;
    rangeEnd: number;
    currentPage: number;
    totalPages: number;
};

export type ListCollectionBiddingBidBookOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    media: CollectionMediaState;
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
        biddingBotStatus: bidBook.biddingBotStatus,
        biddingAuthorization: bidBook.biddingAuthorization
            ? {
                  ...bidBook.biddingAuthorization,
                  maxUnitBidEth: bidBook.biddingAuthorization.maxUnitBidWei
                      ? formatEther(
                            BigInt(bidBook.biddingAuthorization.maxUnitBidWei),
                        )
                      : null,
              }
            : null,
        ownMakerAddress: bidBook.ownMakerAddress,
        bids: mapPersistedBidRowsToView(bidBook.bids),
    };
}

export function mapPersistedBidRowsToView(
    bids: PersistedBiddingBidBookRow[],
): BiddingBidBookRowView[] {
    return bids.map((bid) => ({
        orderId: bid.orderId,
        source: bid.source,
        materialization: bid.materialization,
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
        price: bid.price,
        bidLimits: bid.bidLimits,
        quantity: bid.quantity,
        currencyAddress: bid.currencyAddress,
        currencySymbol: bid.currencySymbol,
        protocolAddress: bid.protocolAddress,
        validUntil: bid.validUntil,
        placedAt: bid.placedAt,
        snapshotRefreshedAtMs: bid.snapshotRefreshedAtMs,
        seenAt: bid.seenAt,
        ownStatus: bid.ownStatus,
    }));
}

// Builds the explicit price object for rows with one marketplace/runtime price.
export function exactBidBookRowPrice(wei: string): BiddingBidBookRowPrice {
    const eth = formatEther(BigInt(wei));
    return {
        kind: TRADING_BIDDING_BID_BOOK_PRICE_KIND.Exact,
        wei,
        eth,
    };
}

// Builds the explicit price object for declared jobs that have not produced a single order price yet.
export function rangeBidBookRowPrice(params: {
    floorWei: string;
    ceilingWei: string;
}): BiddingBidBookRowPrice {
    const limits = bidBookBidLimits(params);
    return {
        kind: TRADING_BIDDING_BID_BOOK_PRICE_KIND.Range,
        ...limits,
    };
}

// Builds the declared strategy floor/ceiling shown separately from market order prices.
export function bidBookBidLimits(params: {
    floorWei: string;
    ceilingWei: string;
}): BiddingBidBookBidLimits {
    return {
        floorWei: params.floorWei,
        floorEth: formatEther(BigInt(params.floorWei)),
        ceilingWei: params.ceilingWei,
        ceilingEth: formatEther(BigInt(params.ceilingWei)),
    };
}

// Resolves the comparable bid-book price for sorting and low-signal filtering.
export function bidBookPriceEffectiveWei(
    price: BiddingBidBookRowPrice,
): string {
    if (price.kind === TRADING_BIDDING_BID_BOOK_PRICE_KIND.Exact) {
        return price.wei;
    }
    return price.ceilingWei;
}

// Resolves the comparable bid-book price in Ether for display-only precision decisions.
export function bidBookPriceEffectiveEth(
    price: BiddingBidBookRowPrice,
): string {
    if (price.kind === TRADING_BIDDING_BID_BOOK_PRICE_KIND.Exact) {
        return price.eth;
    }
    return price.ceilingEth;
}

// Resolves the comparable bid-book price from a persisted row without leaking row internals.
export function persistedBidBookRowEffectiveWei(
    row: Pick<PersistedBiddingBidBookRow, "price">,
): string {
    return bidBookPriceEffectiveWei(row.price);
}

// Marks a bid-book row as a real market/order-book row.
export function marketBidMaterialization(): BiddingBidBookRowMaterialization {
    return {
        kind: TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.MarketBid,
        jobId: null,
        status: null,
        phase: null,
    };
}
