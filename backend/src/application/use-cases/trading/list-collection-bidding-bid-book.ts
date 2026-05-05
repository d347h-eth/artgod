import {
    renderTraitSummaryTemplate,
    TRADING_BIDDING_BID_SCOPE_KIND,
    type ChainRecord,
    type CollectionListItem,
    type TokenAttribute,
    type TokenCard,
} from "@artgod/shared/types";
import {
    decodeOpaqueCursor,
    encodeOpaqueCursor,
} from "@artgod/shared/utils/cursor";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
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
    PersistedBiddingBidBookRow,
} from "./bidding-bid-book.js";
import {
    COLLECTION_BIDDING_BID_SCOPE_FILTER,
    mapPersistedBidBookToView,
    mapPersistedBidRowsToView,
} from "./bidding-bid-book.js";
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
    ) {}

    listCollectionBiddingBidBook(
        input: ListCollectionBiddingBidBookInput,
    ): ListCollectionBiddingBidBookOutput {
        // Resolve the requested chain before reading collection-scoped bid data.
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        // Resolve the collection so bid-book source selection uses canonical collection ids.
        const collection = this.collectionReadPort.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );
        // Load facets for the bidding page filter panel without fetching token cards.
        const rawFacets = this.collectionReadPort.listCollectionTraitFacets(
            chain.publicChainId,
            collection.collectionId,
        );
        const traitFilterPresentation =
            this.customizationReadPort.getTraitFilterPresentationState({
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
                availableTraitKeys: rawFacets.map((facet) => facet.key),
            });
        const facets = applyTraitFilterPresentationToFacets({
            facets: rawFacets,
            config: traitFilterPresentation.effectiveConfig,
        });
        // Read the source-selected bid book: bot snapshot for enabled jobs, canonical orders otherwise.
        const persistedBidBook = this.bidBookRepositoryPort.listCollectionBidBook({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            scopeFilter: input.scopeFilter,
            traitFilterJoinMode: input.traitFilterJoinMode,
            selectedTraits: input.traits,
            selectedTraitRanges: input.traitRanges,
            makerAddress: input.makerAddress ?? null,
        });
        let tokenOfferCardsPage = emptyTokenOfferCardsPage(input.limit);
        if (input.scopeFilter === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token) {
            // Read collection-wide bids from the same source to derive the low-signal token-bid floor.
            const collectionBidBook =
                this.bidBookRepositoryPort.listCollectionBidBook({
                    chainId: chain.publicChainId,
                    collectionId: collection.collectionId,
                    scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection,
                    traitFilterJoinMode: input.traitFilterJoinMode,
                    selectedTraits: [],
                    selectedTraitRanges: [],
                    makerAddress: null,
                });
            tokenOfferCardsPage = paginateTokenOfferCards({
                cards: this.buildTokenOfferCards({
                    chainId: chain.publicChainId,
                    collectionId: collection.collectionId,
                    mediaMode: input.mediaMode,
                    tokenBidBook: persistedBidBook,
                    collectionBidBook,
                    selectedTraits: input.traits,
                    selectedTraitRanges: input.traitRanges,
                }),
                limit: input.limit,
                cursor: input.cursor ?? null,
            });
        }
        const pageCards =
            input.scopeFilter === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token
                ? mapTokenOfferCardsPageToPersistedCards(tokenOfferCardsPage)
                : [];
        const visibleBidBook =
            input.scopeFilter === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token
                ? {
                      state: persistedBidBook.state,
                      bids: pageCards.flatMap((card) => card.persistedOffers),
                  }
                : persistedBidBook;

        return {
            chain,
            collection,
            scopeFilter: input.scopeFilter,
            traits: {
                selected: input.traits,
                selectedRanges: input.traitRanges,
                facets,
            },
            bidBook: mapPersistedBidBookToView(visibleBidBook),
            tokenOfferCards: mapTokenOfferCardsPageToView(tokenOfferCardsPage),
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
        const topCollectionBidWei = topBidPriceWei(params.collectionBidBook.bids);
        const offersByTokenId = groupTokenOffers(
            params.tokenBidBook.bids,
            topCollectionBidWei,
        );
        const tokenIds = sortTokenIdsByTopOffer(offersByTokenId);
        if (tokenIds.length === 0) {
            return [];
        }

        // Load compact token cards for explicit token bids so the UI can reuse token-browser previews.
        const tokenCards = this.collectionReadPort.listCollectionTokenCardsByIds({
            chainId: params.chainId,
            collectionId: params.collectionId,
            tokenIds,
            mediaMode: params.mediaMode,
            includeListings: true,
        });
        const traitSummaryTemplate =
            this.customizationReadPort.getTokenCardTraitSummaryTemplateState({
                chainId: params.chainId,
                collectionId: params.collectionId,
            });

        return tokenCards.flatMap((token) => {
            const offers = offersByTokenId.get(token.tokenId) ?? [];
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
                    token: {
                        ...token,
                        traitSummary: renderTraitSummaryTemplate(
                            traitSummaryTemplate.effectiveConfig.template,
                            token.attributes,
                        ),
                    },
                    persistedOffers: offers,
                },
            ];
        });
    }
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

type PersistedTokenOfferCard = {
    token: TokenCard;
    persistedOffers: PersistedBiddingBidBookRow[];
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

function sortTokenIdsByTopOffer(
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

function tokenMatchesTraitFilters(
    token: TokenCard,
    selectedTraits: TraitFilter[],
    selectedTraitRanges: TraitRangeFilter[],
): boolean {
    return (
        tokenMatchesExactTraitFilters(token.attributes, selectedTraits) &&
        tokenMatchesRangeTraitFilters(token.attributes, selectedTraitRanges)
    );
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
