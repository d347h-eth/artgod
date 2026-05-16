import type {
    ChainRecord,
    CollectionListItem,
    TokenCard,
} from "@artgod/shared/types";
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
    CollectionBiddingBidScopeFilter,
    CollectionBiddingTraitFilterJoinMode,
    ListCollectionBiddingBidBookOutput,
    PersistedBiddingBidBook,
} from "./bidding-bid-book.js";
import {
    COLLECTION_BIDDING_BID_SCOPE_FILTER,
    mapPersistedBidBookToView,
    mapPersistedBidRowsToView,
} from "./bidding-bid-book.js";
import {
    buildPersistedTokenOfferCards,
    buildTokenOfferGroups,
    sortTokenIdsByTopOffer,
    type PersistedTokenOfferCard,
} from "./bidding-token-offer-cards.js";
export type { ListCollectionBiddingBidBookOutput } from "./bidding-bid-book.js";

export type ListCollectionBiddingBidBookInput = {
    chainRef: string;
    collectionRef: string;
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
                "artgod.chain_id": chain.publicChainId,
            },
            () =>
                this.collectionReadPort.resolveCollectionRef(
                    chain.publicChainId,
                    input.collectionRef,
                ),
        );
        const attributes = {
            "artgod.chain_id": chain.publicChainId,
            "artgod.collection_id": collection.collectionId,
            ...buildBiddingRequestSpanAttributes(input),
        };
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
                "artgod.bidding.range_only_keys_count":
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
                "artgod.bidding.facets_count": rawFacets.length,
                "artgod.bidding.range_only_keys_count":
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
                    scopeFilter: input.scopeFilter,
                    traitFilterJoinMode: input.traitFilterJoinMode,
                    selectedTraits: input.traits,
                    selectedTraitRanges: input.traitRanges,
                    makerAddress: input.makerAddress ?? null,
                }),
        );
        let tokenOfferCardsPage = emptyTokenOfferCardsPage(input.limit);
        if (input.scopeFilter === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token) {
            // Read collection-wide bids from the same source to derive the low-signal token-bid floor.
            const collectionBidBook = this.apm.withSyncSpan(
                "backend.bidding.collection_bid_book.collection_floor_bid_book",
                {
                    ...attributes,
                    "artgod.bidding.scope_filter":
                        COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection,
                    "artgod.bidding.trait_filters_count": 0,
                    "artgod.bidding.trait_ranges_count": 0,
                    "artgod.bidding.maker_filter_present": false,
                },
                () =>
                    this.bidBookRepositoryPort.listCollectionBidBook({
                        chainId: chain.publicChainId,
                        collectionId: collection.collectionId,
                        scopeFilter:
                            COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection,
                        traitFilterJoinMode: input.traitFilterJoinMode,
                        selectedTraits: [],
                        selectedTraitRanges: [],
                        makerAddress: null,
                    }),
            );
            const tokenOfferCards = this.apm.withSyncSpan(
                "backend.bidding.collection_bid_book.token_offer_cards",
                {
                    ...attributes,
                    "artgod.bidding.token_bids_count":
                        persistedBidBook.bids.length,
                    "artgod.bidding.collection_bids_count":
                        collectionBidBook.bids.length,
                },
                () =>
                    this.buildTokenOfferCards({
                        chainId: chain.publicChainId,
                        collectionId: collection.collectionId,
                        mediaMode: input.mediaMode,
                        tokenBidBook: persistedBidBook,
                        collectionBidBook,
                        selectedTraits: input.traits,
                        selectedTraitRanges: input.traitRanges,
                    }),
            );
            tokenOfferCardsPage = this.apm.withSyncSpan(
                "backend.bidding.collection_bid_book.token_offer_cards_page",
                {
                    ...attributes,
                    "artgod.bidding.token_offer_cards_count":
                        tokenOfferCards.length,
                },
                () =>
                    paginateTokenOfferCards({
                        cards: tokenOfferCards,
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
                : persistedBidBook;
        const view = this.apm.withSyncSpan(
            "backend.bidding.collection_bid_book.response_map",
            {
                ...attributes,
                "artgod.bidding.visible_bids_count":
                    visibleBidBook.bids.length,
                "artgod.bidding.token_offer_cards_count":
                    tokenOfferCardsPage.items.length,
                "artgod.bidding.token_offer_cards_total_items":
                    tokenOfferCardsPage.totalItems,
                "artgod.bidding.token_offer_cards_total_offers":
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

    private buildTokenOfferCards(params: {
        chainId: number;
        collectionId: number;
        mediaMode?: string;
        tokenBidBook: PersistedBiddingBidBook;
        collectionBidBook: PersistedBiddingBidBook;
        selectedTraits: TraitFilter[];
        selectedTraitRanges: TraitRangeFilter[];
    }): PersistedTokenOfferCard[] {
        const attributes = {
            "artgod.chain_id": params.chainId,
            "artgod.collection_id": params.collectionId,
            "artgod.bidding.token_bids_count": params.tokenBidBook.bids.length,
            "artgod.bidding.collection_bids_count":
                params.collectionBidBook.bids.length,
            "artgod.bidding.trait_filters_count":
                params.selectedTraits.length,
            "artgod.bidding.trait_ranges_count":
                params.selectedTraitRanges.length,
            "artgod.bidding.media_mode_present": Boolean(params.mediaMode),
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
                "artgod.bidding.token_offer_groups_count":
                    offersByTokenId.size,
            },
            () => sortTokenIdsByTopOffer(offersByTokenId),
        );
        if (tokenIds.length === 0) {
            return [];
        }

        // Load compact token cards for explicit token bids so the UI can reuse token-browser previews.
        const tokenCards = this.apm.withSyncSpan(
            "backend.bidding.collection_bid_book.token_offer_token_cards",
            {
                ...attributes,
                "artgod.tokens.count": tokenIds.length,
                "artgod.collection.include_listings": true,
            },
            () =>
                this.collectionReadPort.listCollectionTokenCardsByIds({
                    chainId: params.chainId,
                    collectionId: params.collectionId,
                    tokenIds,
                    mediaMode: params.mediaMode,
                    includeListings: true,
                }),
        );
        const traitSummaryTemplate = this.apm.withSyncSpan(
            "backend.bidding.collection_bid_book.token_offer_trait_summary_template",
            attributes,
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
                ...attributes,
                "artgod.tokens.count": tokenCards.length,
                "artgod.bidding.token_offer_groups_count":
                    offersByTokenId.size,
            },
            () =>
                buildPersistedTokenOfferCards({
                    tokenCards,
                    offersByTokenId,
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
        "artgod.bidding.scope_filter": input.scopeFilter,
        "artgod.bidding.trait_join": input.traitFilterJoinMode,
        "artgod.bidding.trait_filters_count": input.traits.length,
        "artgod.bidding.trait_ranges_count": input.traitRanges.length,
        "artgod.bidding.maker_filter_present": Boolean(input.makerAddress),
        "artgod.bidding.media_mode_present": Boolean(input.mediaMode),
        "artgod.bidding.limit": input.limit,
        "artgod.bidding.cursor_present": Boolean(input.cursor),
    };
}

type PersistedTokenOfferCardsPage = Omit<
    BiddingTokenOfferCardsPage,
    "items"
> & {
    items: PersistedTokenOfferCard[];
};

type TokenOfferCursor = {
    kind: "bidding_token_offers";
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
        totalOffers,
        rangeStart,
        rangeEnd,
        currentPage,
        totalPages,
    };
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
            decoded.kind !== "bidding_token_offers" ||
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
        kind: "bidding_token_offers",
        offset,
    } satisfies TokenOfferCursor);
}
