import type {
    ChainRecord,
    CollectionListItem,
    CollectionMediaState,
    TokenCard,
    CollectionBiddingBidScopeFilter,
    CollectionBiddingTraitFilterJoinMode,
} from "@artgod/shared/types";
import { COLLECTION_BIDDING_BID_SCOPE_FILTER } from "@artgod/shared/types";
import {
    decodeOpaqueCursor,
    encodeOpaqueCursor,
} from "@artgod/shared/utils/cursor";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import {
    NOOP_APM,
    type ApmPort,
    type SpanAttributes,
} from "@artgod/shared/observability/apm";
import type {
    TraitFacet,
    TraitFilter,
    TraitRangeFilter,
} from "@artgod/shared/types/browse";
import { applyTraitFilterPresentationToFacets } from "@artgod/shared/read-models/collections";
import type {
    BiddingBidBookRepositoryPort,
    BiddingTokenOfferCardsPage,
    ListCollectionBiddingBidBookOutput,
    PersistedBiddingBidBook,
    PersistedBiddingBidBookRow,
} from "./bidding-bid-book.js";
import {
    mapPersistedBidBookToView,
    mapPersistedBidRowsToView,
} from "./bidding-bid-book.js";
import { BIDDING_SPAN_ATTRIBUTE } from "./bidding-observability.js";
import {
    buildPersistedTokenOfferCards,
    buildTokenOfferGroups,
    sortTokenIdsByTopOffer,
    type PersistedTokenOfferCard,
} from "./bidding-token-offer-cards.js";
import { filterBidBookRowsByCollectionBidFloor } from "./bidding-bid-book-low-signal.js";
export type { ListCollectionBiddingBidBookOutput } from "./bidding-bid-book.js";

export type ListCollectionBiddingBidBookInput = {
    chainRef: string;
    collectionRef: string;
    includeOwnJobContext: boolean;
    scopeFilter: CollectionBiddingBidScopeFilter;
    traitFilterJoinMode: CollectionBiddingTraitFilterJoinMode;
    traits: TraitFilter[];
    traitRanges: TraitRangeFilter[];
    makerAddress?: string | null;
    mediaMode?: string;
    limit: number;
    cursor?: string | null;
};

export class ListCollectionBiddingBidBookUseCase {
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
            getCollectionMediaState(params: {
                chainId: number;
                collectionId: number;
                mediaMode?: string;
            }): CollectionMediaState;
            listCollectionTraitFacets(
                chainId: number,
                collectionId: number,
                owner?: string,
                options?: {
                    rangeOnlyKeys?: string[];
                },
            ): TraitFacet[];
            listCollectionTokenCardsByIds(params: {
                chainId: number;
                collectionId: number;
                tokenIds: string[];
                mediaMode?: string;
                includeListings?: boolean;
            }): TokenCard[];
            countMarketplaceBiddingSupportedTokensByIds(params: {
                chainId: number;
                collectionId: number;
                tokenIds: string[];
            }): number;
        },
        readonly customizationReadPort: {
            getTraitFilterPresentationState(params: {
                chainId: number;
                collectionId: number;
                availableTraitKeys?: string[];
            }): {
                effectiveConfig: {
                    rangeKeys: string[];
                };
            };
            getTokenCardTraitSummaryTemplateState(params: {
                chainId: number;
                collectionId: number;
            }): {
                effectiveConfig: {
                    template: string;
                };
            };
        },
        readonly bidBookRepositoryPort: BiddingBidBookRepositoryPort,
        readonly apm: ApmPort = NOOP_APM,
    ) {}

    listCollectionBiddingBidBook(
        input: ListCollectionBiddingBidBookInput,
    ): ListCollectionBiddingBidBookOutput {
        // Resolve the requested chain before reading collection-scoped bid data.
        const chain = this.apm.withSyncSpan(
            "backend.bidding.collection_bid_book.chain",
            {},
            () =>
                this.chainRefResolverPort.resolveChainRef(
                    input.chainRef,
                    this.defaultChainId,
                ),
        );
        // Resolve the collection so bid-book source selection uses canonical collection ids.
        const collection = this.apm.withSyncSpan(
            "backend.bidding.collection_bid_book.collection",
            {
                [BIDDING_SPAN_ATTRIBUTE.ChainId]: chain.publicChainId,
            },
            () =>
                this.collectionReadPort.resolveCollectionRef(
                    chain.publicChainId,
                    input.collectionRef,
                ),
        );
        const attributes = {
            [BIDDING_SPAN_ATTRIBUTE.ChainId]: chain.publicChainId,
            [BIDDING_SPAN_ATTRIBUTE.CollectionId]: collection.collectionId,
            ...buildBiddingRequestSpanAttributes(input),
        };
        // Resolve collection media once so the bid-book page does not depend on the removed jobs list.
        const media = this.apm.withSyncSpan(
            "backend.bidding.collection_bid_book.media",
            attributes,
            () =>
                this.collectionReadPort.getCollectionMediaState({
                    chainId: chain.publicChainId,
                    collectionId: collection.collectionId,
                    mediaMode: input.mediaMode,
                }),
        );
        const traitFilterPresentation = this.apm.withSyncSpan(
            "backend.bidding.collection_bid_book.trait_filter_presentation",
            attributes,
            () =>
                this.customizationReadPort.getTraitFilterPresentationState({
                    chainId: chain.publicChainId,
                    collectionId: collection.collectionId,
                }),
        );
        // Load facets for the bidding page filter panel without fetching token cards.
        const rawFacets = this.apm.withSyncSpan(
            "backend.bidding.collection_bid_book.trait_facets",
            {
                ...attributes,
                [BIDDING_SPAN_ATTRIBUTE.RangeOnlyKeysCount]:
                    traitFilterPresentation.effectiveConfig.rangeKeys.length,
            },
            () =>
                this.collectionReadPort.listCollectionTraitFacets(
                    chain.publicChainId,
                    collection.collectionId,
                    undefined,
                    {
                        rangeOnlyKeys:
                            traitFilterPresentation.effectiveConfig.rangeKeys,
                    },
                ),
        );
        const facets = this.apm.withSyncSpan(
            "backend.bidding.collection_bid_book.trait_facets_apply",
            {
                ...attributes,
                [BIDDING_SPAN_ATTRIBUTE.FacetsCount]: rawFacets.length,
                [BIDDING_SPAN_ATTRIBUTE.RangeOnlyKeysCount]:
                    traitFilterPresentation.effectiveConfig.rangeKeys.length,
            },
            () =>
                applyTraitFilterPresentationToFacets({
                    facets: rawFacets,
                    config: traitFilterPresentation.effectiveConfig,
                }),
        );
        // Read the source-selected bid book: bot snapshot for enabled jobs, canonical orders otherwise.
        const persistedBidBook = this.apm.withSyncSpan(
            "backend.bidding.collection_bid_book.bid_book",
            attributes,
            () =>
                this.bidBookRepositoryPort.listCollectionBidBook({
                    chainId: chain.publicChainId,
                    collectionId: collection.collectionId,
                    includeOwnJobContext: input.includeOwnJobContext,
                    scopeFilter: input.scopeFilter,
                    traitFilterJoinMode: input.traitFilterJoinMode,
                    selectedTraits: input.traits,
                    selectedTraitRanges: input.traitRanges,
                    makerAddress: input.makerAddress ?? null,
                }),
        );
        const collectionFloorBidBook = scopeUsesCollectionBidFloor(
            input.scopeFilter,
        )
            ? this.listCollectionFloorBidBook({
                  chainId: chain.publicChainId,
                  collectionId: collection.collectionId,
                  includeOwnJobContext: input.includeOwnJobContext,
                  traitFilterJoinMode: input.traitFilterJoinMode,
                  attributes,
              })
            : null;
        let tokenOfferCardsPage = emptyTokenOfferCardsPage(input.limit);
        if (input.scopeFilter === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token) {
            tokenOfferCardsPage = this.apm.withSyncSpan(
                "backend.bidding.collection_bid_book.token_offer_cards",
                {
                    ...attributes,
                    [BIDDING_SPAN_ATTRIBUTE.TokenBidsCount]:
                        persistedBidBook.bids.length,
                    [BIDDING_SPAN_ATTRIBUTE.CollectionBidsCount]:
                        collectionFloorBidBook?.bids.length ?? 0,
                },
                () =>
                    this.buildTokenOfferCardsPage({
                        chainId: chain.publicChainId,
                        collectionId: collection.collectionId,
                        mediaMode: input.mediaMode,
                        tokenBidBook: persistedBidBook,
                        collectionBidBook:
                            collectionFloorBidBook ??
                            emptyBidBook(persistedBidBook),
                        selectedTraits: input.traits,
                        selectedTraitRanges: input.traitRanges,
                        limit: input.limit,
                        cursor: input.cursor ?? null,
                    }),
            );
        }
        const pageCards =
            input.scopeFilter === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token
                ? mapTokenOfferCardsPageToPersistedCards(tokenOfferCardsPage)
                : [];
        const visibleBidBook =
            input.scopeFilter === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token
                ? {
                      state: persistedBidBook.state,
                      ownMakerAddress: persistedBidBook.ownMakerAddress,
                      bids: pageCards.flatMap((card) => card.persistedOffers),
                  }
                : input.scopeFilter ===
                        COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits &&
                    collectionFloorBidBook
                  ? {
                        state: persistedBidBook.state,
                        ownMakerAddress: persistedBidBook.ownMakerAddress,
                        bids: filterBidBookRowsByCollectionBidFloor({
                            bids: persistedBidBook.bids,
                            collectionBids: collectionFloorBidBook.bids,
                        }),
                    }
                  : persistedBidBook;
        const view = this.apm.withSyncSpan(
            "backend.bidding.collection_bid_book.response_map",
            {
                ...attributes,
                [BIDDING_SPAN_ATTRIBUTE.VisibleBidsCount]:
                    visibleBidBook.bids.length,
                [BIDDING_SPAN_ATTRIBUTE.TokenOfferCardsCount]:
                    tokenOfferCardsPage.items.length,
                [BIDDING_SPAN_ATTRIBUTE.TokenOfferCardsTotalItems]:
                    tokenOfferCardsPage.totalItems,
                [BIDDING_SPAN_ATTRIBUTE.TokenOfferCardsTotalOffers]:
                    tokenOfferCardsPage.totalOffers,
            },
            () => ({
                bidBook: mapPersistedBidBookToView(visibleBidBook),
                tokenOfferCards:
                    mapTokenOfferCardsPageToView(tokenOfferCardsPage),
            }),
        );

        return {
            chain,
            collection,
            media,
            scopeFilter: input.scopeFilter,
            traits: {
                selected: input.traits,
                selectedRanges: input.traitRanges,
                facets,
            },
            bidBook: view.bidBook,
            tokenOfferCards: view.tokenOfferCards,
        };
    }

    private listCollectionFloorBidBook(params: {
        chainId: number;
        collectionId: number;
        includeOwnJobContext: boolean;
        traitFilterJoinMode: CollectionBiddingTraitFilterJoinMode;
        attributes: SpanAttributes;
    }): PersistedBiddingBidBook {
        // Read collection-wide bids from the same source to derive the shared low-signal floor.
        return this.apm.withSyncSpan(
            "backend.bidding.collection_bid_book.collection_floor_bid_book",
            {
                ...params.attributes,
                [BIDDING_SPAN_ATTRIBUTE.ScopeFilter]:
                    COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection,
                [BIDDING_SPAN_ATTRIBUTE.TraitFiltersCount]: 0,
                [BIDDING_SPAN_ATTRIBUTE.TraitRangesCount]: 0,
                [BIDDING_SPAN_ATTRIBUTE.MakerFilterPresent]: false,
            },
            () =>
                this.bidBookRepositoryPort.listCollectionBidBook({
                    chainId: params.chainId,
                    collectionId: params.collectionId,
                    includeOwnJobContext: params.includeOwnJobContext,
                    scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection,
                    traitFilterJoinMode: params.traitFilterJoinMode,
                    selectedTraits: [],
                    selectedTraitRanges: [],
                    makerAddress: null,
                }),
        );
    }

    private buildTokenOfferCardsPage(params: {
        chainId: number;
        collectionId: number;
        mediaMode?: string;
        tokenBidBook: PersistedBiddingBidBook;
        collectionBidBook: PersistedBiddingBidBook;
        selectedTraits: TraitFilter[];
        selectedTraitRanges: TraitRangeFilter[];
        limit: number;
        cursor: string | null;
    }): PersistedTokenOfferCardsPage {
        const attributes = {
            [BIDDING_SPAN_ATTRIBUTE.ChainId]: params.chainId,
            [BIDDING_SPAN_ATTRIBUTE.CollectionId]: params.collectionId,
            [BIDDING_SPAN_ATTRIBUTE.TokenBidsCount]:
                params.tokenBidBook.bids.length,
            [BIDDING_SPAN_ATTRIBUTE.CollectionBidsCount]:
                params.collectionBidBook.bids.length,
            [BIDDING_SPAN_ATTRIBUTE.TraitFiltersCount]:
                params.selectedTraits.length,
            [BIDDING_SPAN_ATTRIBUTE.TraitRangesCount]:
                params.selectedTraitRanges.length,
            [BIDDING_SPAN_ATTRIBUTE.MediaModePresent]: Boolean(
                params.mediaMode,
            ),
        };
        const offersByTokenId = this.apm.withSyncSpan(
            "backend.bidding.collection_bid_book.token_offer_grouping",
            attributes,
            () =>
                buildTokenOfferGroups({
                    tokenBids: params.tokenBidBook.bids,
                    collectionBids: params.collectionBidBook.bids,
                }),
        );
        const tokenIds = this.apm.withSyncSpan(
            "backend.bidding.collection_bid_book.token_offer_sort",
            {
                ...attributes,
                [BIDDING_SPAN_ATTRIBUTE.TokenOfferGroupsCount]:
                    offersByTokenId.size,
            },
            () => sortTokenIdsByTopOffer(offersByTokenId),
        );
        if (tokenIds.length === 0) {
            return emptyTokenOfferCardsPage(params.limit);
        }

        if (!hasTokenOfferCardTraitFilters(params)) {
            const marketplaceBiddingSupportedTotalItems =
                this.collectionReadPort.countMarketplaceBiddingSupportedTokensByIds(
                    {
                        chainId: params.chainId,
                        collectionId: params.collectionId,
                        tokenIds,
                    },
                );
            const tokenIdPage = this.apm.withSyncSpan(
                "backend.bidding.collection_bid_book.token_offer_cards_page",
                {
                    ...attributes,
                    [BIDDING_SPAN_ATTRIBUTE.TokenOfferCardsCount]:
                        tokenIds.length,
                    [BIDDING_SPAN_ATTRIBUTE.TokenOfferCardsTotalItems]:
                        tokenIds.length,
                    [BIDDING_SPAN_ATTRIBUTE.TokenOfferCardsTotalOffers]:
                        countTokenOffers(tokenIds, offersByTokenId),
                },
                () =>
                    paginateTokenOfferTokenIds({
                        tokenIds,
                        offersByTokenId,
                        marketplaceBiddingSupportedTotalItems,
                        limit: params.limit,
                        cursor: params.cursor,
                    }),
            );
            return {
                ...tokenIdPage,
                items: this.hydrateTokenOfferCards({
                    ...params,
                    attributes,
                    tokenIds: tokenIdPage.items,
                    offersByTokenId,
                    tokenOfferGroupsCount: tokenIdPage.items.length,
                }),
            };
        }

        const tokenOfferCards = this.hydrateTokenOfferCards({
            ...params,
            attributes,
            tokenIds,
            offersByTokenId,
            tokenOfferGroupsCount: tokenIds.length,
        });
        return this.apm.withSyncSpan(
            "backend.bidding.collection_bid_book.token_offer_cards_page",
            {
                ...attributes,
                [BIDDING_SPAN_ATTRIBUTE.TokenOfferCardsCount]:
                    tokenOfferCards.length,
                [BIDDING_SPAN_ATTRIBUTE.TokenOfferCardsTotalItems]:
                    tokenOfferCards.length,
                [BIDDING_SPAN_ATTRIBUTE.TokenOfferCardsTotalOffers]:
                    countTokenOffers(tokenIds, offersByTokenId),
            },
            () =>
                paginateTokenOfferCards({
                    cards: tokenOfferCards,
                    limit: params.limit,
                    cursor: params.cursor,
                }),
        );
    }

    private hydrateTokenOfferCards(params: {
        chainId: number;
        collectionId: number;
        mediaMode?: string;
        attributes: SpanAttributes;
        tokenIds: string[];
        offersByTokenId: Map<string, PersistedBiddingBidBookRow[]>;
        tokenOfferGroupsCount: number;
        selectedTraits: TraitFilter[];
        selectedTraitRanges: TraitRangeFilter[];
    }): PersistedTokenOfferCard[] {
        if (params.tokenIds.length === 0) {
            return [];
        }

        // Load compact token cards for explicit token bids so the UI can reuse token-browser previews.
        const tokenCards = this.apm.withSyncSpan(
            "backend.bidding.collection_bid_book.token_offer_token_cards",
            {
                ...params.attributes,
                [BIDDING_SPAN_ATTRIBUTE.TokensCount]: params.tokenIds.length,
                [BIDDING_SPAN_ATTRIBUTE.CollectionIncludeListings]: true,
            },
            () =>
                this.collectionReadPort.listCollectionTokenCardsByIds({
                    chainId: params.chainId,
                    collectionId: params.collectionId,
                    tokenIds: params.tokenIds,
                    mediaMode: params.mediaMode,
                    includeListings: true,
                }),
        );
        const traitSummaryTemplate = this.apm.withSyncSpan(
            "backend.bidding.collection_bid_book.token_offer_trait_summary_template",
            params.attributes,
            () =>
                this.customizationReadPort.getTokenCardTraitSummaryTemplateState(
                    {
                        chainId: params.chainId,
                        collectionId: params.collectionId,
                    },
                ),
        );

        return this.apm.withSyncSpan(
            "backend.bidding.collection_bid_book.token_offer_card_build",
            {
                ...params.attributes,
                [BIDDING_SPAN_ATTRIBUTE.TokensCount]: tokenCards.length,
                [BIDDING_SPAN_ATTRIBUTE.TokenOfferGroupsCount]:
                    params.tokenOfferGroupsCount,
            },
            () =>
                buildPersistedTokenOfferCards({
                    tokenCards,
                    offersByTokenId: params.offersByTokenId,
                    selectedTraits: params.selectedTraits,
                    selectedTraitRanges: params.selectedTraitRanges,
                    traitSummaryTemplate:
                        traitSummaryTemplate.effectiveConfig.template,
                }),
        );
    }
}

function buildBiddingRequestSpanAttributes(
    input: ListCollectionBiddingBidBookInput,
): SpanAttributes {
    return {
        [BIDDING_SPAN_ATTRIBUTE.ScopeFilter]: input.scopeFilter,
        [BIDDING_SPAN_ATTRIBUTE.TraitJoin]: input.traitFilterJoinMode,
        [BIDDING_SPAN_ATTRIBUTE.TraitFiltersCount]: input.traits.length,
        [BIDDING_SPAN_ATTRIBUTE.TraitRangesCount]: input.traitRanges.length,
        [BIDDING_SPAN_ATTRIBUTE.MakerFilterPresent]: Boolean(
            input.makerAddress,
        ),
        [BIDDING_SPAN_ATTRIBUTE.MediaModePresent]: Boolean(input.mediaMode),
        [BIDDING_SPAN_ATTRIBUTE.Limit]: input.limit,
        [BIDDING_SPAN_ATTRIBUTE.CursorPresent]: Boolean(input.cursor),
    };
}

type PersistedTokenOfferCardsPage = Omit<
    BiddingTokenOfferCardsPage,
    "items"
> & {
    items: PersistedTokenOfferCard[];
};

type TokenOfferTokenIdPage = Omit<PersistedTokenOfferCardsPage, "items"> & {
    items: string[];
};

const TOKEN_OFFER_CURSOR_KIND = "bidding_token_offers";

type TokenOfferCursor = {
    kind: typeof TOKEN_OFFER_CURSOR_KIND;
    offset: number;
};

function emptyTokenOfferCardsPage(limit: number): PersistedTokenOfferCardsPage {
    return {
        items: [],
        prevCursor: null,
        nextCursor: null,
        limit,
        totalItems: 0,
        totalOffers: 0,
        rangeStart: 0,
        rangeEnd: 0,
        currentPage: 0,
        totalPages: 0,
        marketplaceBiddingSupportedTotalItems: 0,
    };
}

function paginateTokenOfferCards(params: {
    cards: PersistedTokenOfferCard[];
    limit: number;
    cursor: string | null;
}): PersistedTokenOfferCardsPage {
    const offset = decodeTokenOfferCursorOffset(params.cursor);
    const totalItems = params.cards.length;
    const totalOffers = params.cards.reduce(
        (sum, card) => sum + card.persistedOffers.length,
        0,
    );
    const marketplaceBiddingSupportedTotalItems = params.cards.filter(
        (card) => card.token.marketplaceBiddingSupported,
    ).length;
    const pageItems = params.cards.slice(offset, offset + params.limit);
    const rangeStart = pageItems.length === 0 ? 0 : offset + 1;
    const rangeEnd = offset + pageItems.length;
    const totalPages =
        totalItems === 0 ? 0 : Math.ceil(totalItems / params.limit);
    const currentPage =
        totalItems === 0 ? 0 : Math.floor(offset / params.limit) + 1;

    return {
        items: pageItems,
        prevCursor:
            offset > 0
                ? encodeTokenOfferCursor(Math.max(0, offset - params.limit))
                : null,
        nextCursor:
            offset + params.limit < totalItems
                ? encodeTokenOfferCursor(offset + params.limit)
                : null,
        limit: params.limit,
        totalItems,
        marketplaceBiddingSupportedTotalItems,
        totalOffers,
        rangeStart,
        rangeEnd,
        currentPage,
        totalPages,
    };
}

function paginateTokenOfferTokenIds(params: {
    tokenIds: string[];
    offersByTokenId: Map<string, PersistedBiddingBidBookRow[]>;
    marketplaceBiddingSupportedTotalItems: number;
    limit: number;
    cursor: string | null;
}): TokenOfferTokenIdPage {
    const offset = decodeTokenOfferCursorOffset(params.cursor);
    const totalItems = params.tokenIds.length;
    const pageItems = params.tokenIds.slice(offset, offset + params.limit);
    const rangeStart = pageItems.length === 0 ? 0 : offset + 1;
    const rangeEnd = offset + pageItems.length;
    const totalPages =
        totalItems === 0 ? 0 : Math.ceil(totalItems / params.limit);
    const currentPage =
        totalItems === 0 ? 0 : Math.floor(offset / params.limit) + 1;

    return {
        items: pageItems,
        prevCursor:
            offset > 0
                ? encodeTokenOfferCursor(Math.max(0, offset - params.limit))
                : null,
        nextCursor:
            offset + params.limit < totalItems
                ? encodeTokenOfferCursor(offset + params.limit)
                : null,
        limit: params.limit,
        totalItems,
        marketplaceBiddingSupportedTotalItems:
            params.marketplaceBiddingSupportedTotalItems,
        totalOffers: countTokenOffers(params.tokenIds, params.offersByTokenId),
        rangeStart,
        rangeEnd,
        currentPage,
        totalPages,
    };
}

function hasTokenOfferCardTraitFilters(params: {
    selectedTraits: TraitFilter[];
    selectedTraitRanges: TraitRangeFilter[];
}): boolean {
    return (
        params.selectedTraits.length > 0 ||
        params.selectedTraitRanges.length > 0
    );
}

function scopeUsesCollectionBidFloor(
    scopeFilter: CollectionBiddingBidScopeFilter,
): boolean {
    return (
        scopeFilter === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token ||
        scopeFilter === COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits
    );
}

function emptyBidBook(
    template: PersistedBiddingBidBook,
): PersistedBiddingBidBook {
    return {
        ...template,
        bids: [],
    };
}

function countTokenOffers(
    tokenIds: string[],
    offersByTokenId: Map<string, PersistedBiddingBidBookRow[]>,
): number {
    return tokenIds.reduce(
        (count, tokenId) => count + (offersByTokenId.get(tokenId)?.length ?? 0),
        0,
    );
}

function mapTokenOfferCardsPageToView(
    page: PersistedTokenOfferCardsPage,
): BiddingTokenOfferCardsPage {
    return {
        ...page,
        items: page.items.map((card) => ({
            ...card.token,
            offers: mapPersistedBidRowsToView(card.persistedOffers),
        })),
    };
}

function mapTokenOfferCardsPageToPersistedCards(
    page: PersistedTokenOfferCardsPage,
): PersistedTokenOfferCard[] {
    return page.items;
}

function decodeTokenOfferCursorOffset(cursor: string | null): number {
    if (!cursor) {
        return 0;
    }

    try {
        const decoded = decodeOpaqueCursor<TokenOfferCursor>(cursor);
        if (
            decoded.kind !== TOKEN_OFFER_CURSOR_KIND ||
            !Number.isInteger(decoded.offset) ||
            decoded.offset < 0
        ) {
            throw new Error("invalid token offer cursor");
        }
        return decoded.offset;
    } catch {
        throw new ReadModelBadRequestError("Invalid cursor");
    }
}

function encodeTokenOfferCursor(offset: number): string {
    return encodeOpaqueCursor({
        kind: TOKEN_OFFER_CURSOR_KIND,
        offset,
    } satisfies TokenOfferCursor);
}
