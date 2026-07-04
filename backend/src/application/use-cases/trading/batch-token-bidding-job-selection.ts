import { DEFAULT_PAGE_LIMIT } from "@artgod/shared/config/pagination";
import type {
    TokenCard,
    TokenBrowserStatus,
    TokenCursorPage,
    TraitFilter,
    TraitRangeFilter,
} from "@artgod/shared/types";
import {
    COLLECTION_BIDDING_BID_SCOPE_FILTER,
    COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
    TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND,
} from "@artgod/shared/types";
import type { BiddingBidBookRepositoryPort } from "./bidding-bid-book.js";
import {
    buildTokenOfferGroups,
    sortTokenIdsByTopOffer,
    tokenMatchesTraitFiltersWithJoinMode,
} from "./bidding-token-offer-cards.js";
import {
    isTokenMarketplaceBiddingSupported,
    marketplaceBiddingSupportedTokens,
} from "./token-marketplace-bidding.js";
import {
    TradingValidationError,
    type BatchTokenBiddingJobSelection,
} from "./types.js";

export type BatchTokenBiddingJobSelectionTokenReadPort = {
    listCollectionTokens(params: {
        chainId: number;
        collectionId: number;
        tokenStatus: TokenBrowserStatus;
        limit: number;
        cursor?: string;
        traitFilters?: TraitFilter[];
        traitRangeFilters?: TraitRangeFilter[];
        owner?: string;
    }): TokenCursorPage;
    listCollectionTokenCardsByIds(params: {
        chainId: number;
        collectionId: number;
        tokenIds: string[];
    }): TokenCard[];
};

export type BatchTokenBiddingJobSelectionBidBookReadPort = Pick<
    BiddingBidBookRepositoryPort,
    "listCollectionBidBook"
>;

// Resolves a user-facing batch token target into concrete biddable token IDs.
export function resolveBatchTokenBiddingJobSelectionTokenIds(params: {
    chainId: number;
    collectionId: number;
    selection: BatchTokenBiddingJobSelection;
    collectionReadPort: BatchTokenBiddingJobSelectionTokenReadPort;
    bidBookRepositoryPort: BatchTokenBiddingJobSelectionBidBookReadPort;
}): string[] {
    if (
        params.selection.type ===
        TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenIds
    ) {
        return resolveExplicitTokenIds({
            chainId: params.chainId,
            collectionId: params.collectionId,
            selection: params.selection,
            collectionReadPort: params.collectionReadPort,
        });
    }
    if (
        params.selection.type ===
        TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenOfferFilter
    ) {
        return resolveTokenOfferFilterTokenIds({
            chainId: params.chainId,
            collectionId: params.collectionId,
            selection: params.selection,
            collectionReadPort: params.collectionReadPort,
            bidBookRepositoryPort: params.bidBookRepositoryPort,
        });
    }
    return resolveFilteredTokenIds({
        chainId: params.chainId,
        collectionId: params.collectionId,
        selection: params.selection,
        collectionReadPort: params.collectionReadPort,
    });
}

function resolveExplicitTokenIds(params: {
    chainId: number;
    collectionId: number;
    selection: Extract<
        BatchTokenBiddingJobSelection,
        { type: typeof TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenIds }
    >;
    collectionReadPort: BatchTokenBiddingJobSelectionTokenReadPort;
}): string[] {
    const tokenIds = uniqueNonEmptyTokenIds(params.selection.tokenIds);
    if (tokenIds.length === 0) {
        return [];
    }
    // Verify explicit token IDs belong to this collection before any job operation.
    const cards = params.collectionReadPort.listCollectionTokenCardsByIds({
        chainId: params.chainId,
        collectionId: params.collectionId,
        tokenIds,
    });
    const found = new Set(cards.map((card) => card.tokenId));
    const missing = tokenIds.filter((tokenId) => !found.has(tokenId));
    if (missing.length > 0) {
        throw new TradingValidationError(`unknown token id ${missing[0]}`);
    }
    return marketplaceBiddingSupportedTokens(cards).map((card) => card.tokenId);
}

function resolveFilteredTokenIds(params: {
    chainId: number;
    collectionId: number;
    selection: Extract<
        BatchTokenBiddingJobSelection,
        {
            type: typeof TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenBrowserFilter;
        }
    >;
    collectionReadPort: BatchTokenBiddingJobSelectionTokenReadPort;
}): string[] {
    const tokenIds: string[] = [];
    let cursor: string | undefined;
    do {
        // Read one token-browser page at a time so large filtered selections do not preallocate.
        const page = params.collectionReadPort.listCollectionTokens({
            chainId: params.chainId,
            collectionId: params.collectionId,
            tokenStatus: params.selection.tokenStatus,
            limit: DEFAULT_PAGE_LIMIT,
            cursor,
            traitFilters: params.selection.traits,
            traitRangeFilters: params.selection.traitRanges,
            owner: params.selection.ownerAddress ?? undefined,
        });
        for (const token of page.items) {
            if (isTokenMarketplaceBiddingSupported(token)) {
                tokenIds.push(token.tokenId);
            }
        }
        cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return uniqueNonEmptyTokenIds(tokenIds);
}

function resolveTokenOfferFilterTokenIds(params: {
    chainId: number;
    collectionId: number;
    selection: Extract<
        BatchTokenBiddingJobSelection,
        {
            type: typeof TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenOfferFilter;
        }
    >;
    collectionReadPort: BatchTokenBiddingJobSelectionTokenReadPort;
    bidBookRepositoryPort: BatchTokenBiddingJobSelectionBidBookReadPort;
}): string[] {
    // Read token-scoped bids from the same source-selection path used by the offers page.
    const tokenBidBook = params.bidBookRepositoryPort.listCollectionBidBook({
        chainId: params.chainId,
        collectionId: params.collectionId,
        includeOwnJobContext: false,
        scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Token,
        traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And,
        selectedTraits: [],
        selectedTraitRanges: [],
        makerAddress: params.selection.makerAddress ?? null,
    });
    // Read collection bids so low-signal token offers are filtered exactly like the token-offer cards.
    const collectionBidBook = params.bidBookRepositoryPort.listCollectionBidBook({
        chainId: params.chainId,
        collectionId: params.collectionId,
        includeOwnJobContext: false,
        scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection,
        traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And,
        selectedTraits: [],
        selectedTraitRanges: [],
        makerAddress: null,
    });
    const offersByTokenId = buildTokenOfferGroups({
        tokenBids: tokenBidBook.bids,
        collectionBids: collectionBidBook.bids,
    });
    const tokenIds = sortTokenIdsByTopOffer(offersByTokenId);
    if (tokenIds.length === 0) {
        return [];
    }
    // Hydrate matched token IDs so trait filters apply to token metadata, not bid payloads.
    const cards = params.collectionReadPort.listCollectionTokenCardsByIds({
        chainId: params.chainId,
        collectionId: params.collectionId,
        tokenIds,
    });
    const cardsById = new Map(cards.map((card) => [card.tokenId, card]));
    return tokenIds.filter((tokenId) => {
        const card = cardsById.get(tokenId);
        return (
            card !== undefined &&
            isTokenMarketplaceBiddingSupported(card) &&
            tokenMatchesTraitFiltersWithJoinMode(
                card,
                params.selection.traits,
                params.selection.traitRanges,
                params.selection.traitJoinMode,
            )
        );
    });
}

function uniqueNonEmptyTokenIds(values: string[]): string[] {
    const seen = new Set<string>();
    const tokenIds: string[] = [];
    for (const value of values) {
        const tokenId = value.trim();
        if (!tokenId || seen.has(tokenId)) {
            continue;
        }
        seen.add(tokenId);
        tokenIds.push(tokenId);
    }
    return tokenIds;
}
