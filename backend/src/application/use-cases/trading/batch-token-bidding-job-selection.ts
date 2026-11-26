import {
    ordinaryViewTraits,
    resolveTraitScope,
    type CatalogRequest,
    type CatalogScopeReadPort,
} from "../collections/collection-views.js";
import type { CollectionListItem } from "@artgod/shared/types/browse";
import type { TraitReadContext } from "@artgod/shared/types/trait-catalog";
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
    tokenCardIdBatches,
    filterTokenOfferGroupsByOwnFilters,
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
import { assertBiddingBidBookFiltersAllowed } from "./bidding-bid-book-filter-validation.js";

export type BatchTokenBiddingJobSelectionTokenReadPort = {
    listCollectionTokens(params: {
        traitContext?: TraitReadContext;
        chainId: number;
        collectionId: number;
        tokenStatus: TokenBrowserStatus;
        limit: number;
        cursor?: string;
        traitFilters?: TraitFilter[];
        traitRangeFilters?: TraitRangeFilter[];
        owner?: string;
    }): TokenCursorPage;
    /** Existing cards in requested token ID order. */
    listCollectionTokenCardsByIds(params: {
        traitContext?: TraitReadContext;
        chainId: number;
        collectionId: number;
        tokenIds: string[];
    }): TokenCard[];
};

export type BatchTokenBiddingJobSelectionBidBookReadPort = Pick<
    BiddingBidBookRepositoryPort,
    "listCollectionBidBook"
>;

export function resolveBatchTraitScope(
    port: CatalogScopeReadPort,
    collection: CollectionListItem,
    input: CatalogRequest & { selection: BatchTokenBiddingJobSelection },
) {
    const selection = input.selection;
    // An explicitly named list of token IDs can also be submitted outside the browser.
    if (
        selection.type ===
            TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenIds &&
        input.view === undefined &&
        input.viewGroup === undefined &&
        input.traitCatalog === undefined &&
        input.generation === undefined
    )
        return { traitContext: undefined, selection };
    const { traitContext, view } = resolveTraitScope(port, collection, input);
    if (
        !view ||
        selection.type ===
            TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenIds
    )
        return { traitContext, selection };
    return {
        traitContext,
        selection: {
            ...selection,
            traits: ordinaryViewTraits(view.pinnedTraits, selection.traits),
        },
    };
}

// Resolves a user-facing batch token target into concrete biddable token IDs.
export function resolveBatchTokenBiddingJobSelectionTokenIds(params: {
    traitContext?: TraitReadContext;
    chainId: number;
    collectionId: number;
    includeOwnJobContext: boolean;
    selection: BatchTokenBiddingJobSelection;
    collectionReadPort: BatchTokenBiddingJobSelectionTokenReadPort;
    bidBookRepositoryPort: BatchTokenBiddingJobSelectionBidBookReadPort;
}): string[] {
    if (
        params.selection.type ===
        TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenIds
    ) {
        return resolveExplicitTokenIds({
            traitContext: params.traitContext,
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
            traitContext: params.traitContext,
            chainId: params.chainId,
            collectionId: params.collectionId,
            includeOwnJobContext: params.includeOwnJobContext,
            selection: params.selection,
            collectionReadPort: params.collectionReadPort,
            bidBookRepositoryPort: params.bidBookRepositoryPort,
        });
    }
    return resolveFilteredTokenIds({
        traitContext: params.traitContext,
        chainId: params.chainId,
        collectionId: params.collectionId,
        selection: params.selection,
        collectionReadPort: params.collectionReadPort,
    });
}

function resolveExplicitTokenIds(params: {
    traitContext?: TraitReadContext;
    chainId: number;
    collectionId: number;
    selection: Extract<
        BatchTokenBiddingJobSelection,
        { type: typeof TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenIds }
    >;
    collectionReadPort: BatchTokenBiddingJobSelectionTokenReadPort;
}): string[] {
    const tokenIds = uniqueNonEmptyTokenIds(params.selection.tokenIds);
    const supported: string[] = [];
    for (const batch of readTokenCardBatches(params, tokenIds)) {
        const found = new Set(batch.cards.map((card) => card.tokenId));
        const missing = batch.tokenIds.find((id) => !found.has(id));
        if (missing !== undefined) {
            throw new TradingValidationError(`unknown token id ${missing}`);
        }
        for (const card of marketplaceBiddingSupportedTokens(batch.cards)) {
            supported.push(card.tokenId);
        }
    }
    return supported;
}

function resolveFilteredTokenIds(params: {
    traitContext?: TraitReadContext;
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
            traitContext: params.traitContext,
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
    traitContext?: TraitReadContext;
    chainId: number;
    collectionId: number;
    includeOwnJobContext: boolean;
    selection: Extract<
        BatchTokenBiddingJobSelection,
        {
            type: typeof TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenOfferFilter;
        }
    >;
    collectionReadPort: BatchTokenBiddingJobSelectionTokenReadPort;
    bidBookRepositoryPort: BatchTokenBiddingJobSelectionBidBookReadPort;
}): string[] {
    assertBiddingBidBookFiltersAllowed({
        includeOwnJobContext: params.includeOwnJobContext,
        scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Token,
        makerAddress: params.selection.makerAddress,
        ownershipFilter: params.selection.ownershipFilter,
        ownStateFilter: params.selection.ownStateFilter,
        priceTierFilter: params.selection.priceTierFilter,
    });

    // Token Offers applies AND across fields. A direct API batch may request OR
    // across fields, which must keep all candidates for the card-level check.
    const { traits, traitRanges, traitJoinMode } = params.selection;
    const canFilterBook =
        traitJoinMode === COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And ||
        traits.length + traitRanges.length === 1;
    // Read token-scoped bids from the same source-selection path used by the offers page.
    const tokenBidBook = params.bidBookRepositoryPort.listCollectionBidBook({
        traitContext: params.traitContext,
        chainId: params.chainId,
        collectionId: params.collectionId,
        includeOwnJobContext: params.includeOwnJobContext,
        scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Token,
        traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And,
        selectedTraits: canFilterBook ? traits : [],
        selectedTraitRanges: canFilterBook ? traitRanges : [],
        makerAddress: params.selection.makerAddress ?? null,
        ownershipFilter: params.selection.ownershipFilter ?? null,
    });
    // Read collection bids so low-signal token offers are filtered exactly like the token-offer cards.
    const collectionBidBook =
        params.bidBookRepositoryPort.listCollectionBidBook({
            traitContext: params.traitContext,
            chainId: params.chainId,
            collectionId: params.collectionId,
            includeOwnJobContext: params.includeOwnJobContext,
            scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection,
            traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And,
            selectedTraits: [],
            selectedTraitRanges: [],
            makerAddress: null,
            ownershipFilter: null,
        });
    const offersByTokenId = filterTokenOfferGroupsByOwnFilters(
        buildTokenOfferGroups({
            tokenBids: tokenBidBook.bids,
            collectionBids: collectionBidBook.bids,
        }),
        params.selection,
    );
    const tokenIds = sortTokenIdsByTopOffer(offersByTokenId);
    const matches: string[] = [];
    for (const batch of readTokenCardBatches(params, tokenIds)) {
        for (const card of marketplaceBiddingSupportedTokens(batch.cards)) {
            if (
                tokenMatchesTraitFiltersWithJoinMode(
                    card,
                    traits,
                    traitRanges,
                    traitJoinMode,
                )
            ) {
                matches.push(card.tokenId);
            }
        }
    }
    return matches;
}

// Lookup and save only retain eligible IDs. Read bounded groups of cards even
// when the query or an explicit selection covers the entire collection.
function* readTokenCardBatches(
    params: {
        chainId: number;
        collectionId: number;
        traitContext?: TraitReadContext;
        collectionReadPort: BatchTokenBiddingJobSelectionTokenReadPort;
    },
    tokenIds: string[],
) {
    for (const batch of tokenCardIdBatches(tokenIds)) {
        const cards = params.collectionReadPort.listCollectionTokenCardsByIds({
            chainId: params.chainId,
            collectionId: params.collectionId,
            traitContext: params.traitContext,
            tokenIds: batch,
        });
        yield { tokenIds: batch, cards };
    }
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
