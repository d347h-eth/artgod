import { describe, expect, it } from "vitest";
import type { ApmPort, SpanAttributes } from "@artgod/shared/observability/apm";
import {
    TRADING_BIDDING_BID_BOOK_SOURCE,
    TRADING_BIDDING_BID_SCOPE_KIND,
} from "@artgod/shared/types";
import { TRAIT_FILTER_DISPLAY_KIND } from "@artgod/shared/types";
import type {
    ChainRecord,
    CollectionListItem,
    TokenCard,
    TraitFacet,
} from "@artgod/shared/types/browse";
import {
    COLLECTION_BIDDING_BID_SCOPE_FILTER,
    COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
    type BiddingBidBookRepositoryPort,
    type PersistedBiddingBidBook,
    type PersistedBiddingBidBookRow,
} from "./bidding-bid-book.js";
import { BIDDING_SPAN_ATTRIBUTE } from "./bidding-observability.js";
import { ListCollectionBiddingBidBookUseCase } from "./list-collection-bidding-bid-book.js";

class CapturingApm implements ApmPort {
    readonly spans: Array<{ name: string; attributes: SpanAttributes }> = [];

    async withSpan<T>(
        name: string,
        attributes: SpanAttributes,
        run: () => Promise<T>,
    ): Promise<T> {
        this.spans.push({ name, attributes });
        return run();
    }

    withSyncSpan<T>(name: string, attributes: SpanAttributes, run: () => T): T {
        this.spans.push({ name, attributes });
        return run();
    }
}

describe("ListCollectionBiddingBidBookUseCase observability", () => {
    it("wraps bidding phases and token-offer card work in spans", () => {
        const apm = new CapturingApm();
        const bidBookScopes: string[] = [];
        const repository: BiddingBidBookRepositoryPort = {
            listCollectionBidBook: (params) => {
                bidBookScopes.push(params.scopeFilter);
                return params.scopeFilter ===
                    COLLECTION_BIDDING_BID_SCOPE_FILTER.Token
                    ? bidBook([bidRow("token-offer", "100")])
                    : bidBook([bidRow("collection-floor", "20")]);
            },
            listTokenBidBook: () => bidBook([]),
        };
        const useCase = new ListCollectionBiddingBidBookUseCase(
            1,
            {
                resolveChainRef: () => chain(),
            },
            {
                resolveCollectionRef: () => collection(),
                listCollectionTraitFacets: () => [traitFacet("Mode")],
                listCollectionTokenCardsByIds: () => [tokenCard("7")],
            },
            {
                getTraitFilterPresentationState: () => ({
                    effectiveConfig: {
                        rangeKeys: ["Level"],
                    },
                }),
                getTokenCardTraitSummaryTemplateState: () => ({
                    effectiveConfig: {
                        template: "{Mode}",
                    },
                }),
            },
            repository,
            apm,
        );

        const output = useCase.listCollectionBiddingBidBook({
            chainRef: "ethereum",
            collectionRef: "terraforms",
            scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Token,
            traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
            traits: [{ key: "Mode", value: "Terrain" }],
            traitRanges: [],
            makerAddress: "0x1111111111111111111111111111111111111111",
            mediaMode: "artifact",
            limit: 25,
        });

        expect(bidBookScopes).toEqual(["token", "collection"]);
        expect(output.tokenOfferCards.items).toHaveLength(1);
        expect(output.bidBook.bids.map((bid) => bid.orderId)).toEqual([
            "token-offer",
        ]);
        expect(apm.spans.map((span) => span.name)).toEqual([
            "backend.bidding.collection_bid_book.chain",
            "backend.bidding.collection_bid_book.collection",
            "backend.bidding.collection_bid_book.trait_filter_presentation",
            "backend.bidding.collection_bid_book.trait_facets",
            "backend.bidding.collection_bid_book.trait_facets_apply",
            "backend.bidding.collection_bid_book.bid_book",
            "backend.bidding.collection_bid_book.collection_floor_bid_book",
            "backend.bidding.collection_bid_book.token_offer_cards",
            "backend.bidding.collection_bid_book.token_offer_grouping",
            "backend.bidding.collection_bid_book.token_offer_sort",
            "backend.bidding.collection_bid_book.token_offer_token_cards",
            "backend.bidding.collection_bid_book.token_offer_trait_summary_template",
            "backend.bidding.collection_bid_book.token_offer_card_build",
            "backend.bidding.collection_bid_book.token_offer_cards_page",
            "backend.bidding.collection_bid_book.response_map",
        ]);
        expect(apm.spans).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    name: "backend.bidding.collection_bid_book.bid_book",
                    attributes: expect.objectContaining({
                        [BIDDING_SPAN_ATTRIBUTE.ChainId]: 1,
                        [BIDDING_SPAN_ATTRIBUTE.CollectionId]: 7,
                        [BIDDING_SPAN_ATTRIBUTE.ScopeFilter]:
                            COLLECTION_BIDDING_BID_SCOPE_FILTER.Token,
                        [BIDDING_SPAN_ATTRIBUTE.TraitFiltersCount]: 1,
                        [BIDDING_SPAN_ATTRIBUTE.MakerFilterPresent]: true,
                    }),
                }),
                expect.objectContaining({
                    name: "backend.bidding.collection_bid_book.token_offer_cards",
                    attributes: expect.objectContaining({
                        [BIDDING_SPAN_ATTRIBUTE.TokenBidsCount]: 1,
                        [BIDDING_SPAN_ATTRIBUTE.CollectionBidsCount]: 1,
                    }),
                }),
                expect.objectContaining({
                    name: "backend.bidding.collection_bid_book.response_map",
                    attributes: expect.objectContaining({
                        [BIDDING_SPAN_ATTRIBUTE.VisibleBidsCount]: 1,
                        [BIDDING_SPAN_ATTRIBUTE.TokenOfferCardsCount]: 1,
                        [BIDDING_SPAN_ATTRIBUTE.TokenOfferCardsTotalOffers]:
                            1,
                    }),
                }),
            ]),
        );
    });

    it("paginates unfiltered token offers before hydrating token cards", () => {
        const hydratedTokenIds: string[][] = [];
        const repository: BiddingBidBookRepositoryPort = {
            listCollectionBidBook: (params) =>
                params.scopeFilter ===
                COLLECTION_BIDDING_BID_SCOPE_FILTER.Token
                    ? bidBook([
                          bidRow("token-1-offer", "300", "1"),
                          bidRow("token-2-offer", "200", "2"),
                          bidRow("token-3-offer", "100", "3"),
                      ])
                    : bidBook([bidRow("collection-floor", "1")]),
            listTokenBidBook: () => bidBook([]),
        };
        const useCase = new ListCollectionBiddingBidBookUseCase(
            1,
            {
                resolveChainRef: () => chain(),
            },
            {
                resolveCollectionRef: () => collection(),
                listCollectionTraitFacets: () => [],
                listCollectionTokenCardsByIds: (params) => {
                    hydratedTokenIds.push(params.tokenIds);
                    return params.tokenIds.map((tokenId) =>
                        tokenCard(tokenId),
                    );
                },
            },
            {
                getTraitFilterPresentationState: () => ({
                    effectiveConfig: {
                        rangeKeys: [],
                    },
                }),
                getTokenCardTraitSummaryTemplateState: () => ({
                    effectiveConfig: {
                        template: "{Mode}",
                    },
                }),
            },
            repository,
        );

        const output = useCase.listCollectionBiddingBidBook({
            chainRef: "ethereum",
            collectionRef: "terraforms",
            scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Token,
            traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And,
            traits: [],
            traitRanges: [],
            limit: 2,
        });

        expect(hydratedTokenIds).toEqual([["1", "2"]]);
        expect(output.tokenOfferCards.totalItems).toBe(3);
        expect(output.tokenOfferCards.totalOffers).toBe(3);
        expect(output.tokenOfferCards.items.map((card) => card.tokenId)).toEqual(
            ["1", "2"],
        );
        expect(output.bidBook.bids.map((bid) => bid.orderId)).toEqual([
            "token-1-offer",
            "token-2-offer",
        ]);
    });
});

function chain(): ChainRecord {
    return {
        id: 1,
        type: "evm",
        publicChainId: 1,
        slug: "ethereum",
        name: "Ethereum",
    };
}

function collection(): CollectionListItem {
    return {
        chainId: 1,
        collectionId: 7,
        slug: "terraforms",
        address: "0x0000000000000000000000000000000000000001",
        standard: "erc721",
        status: "live",
        deploymentBlock: 1,
        bootstrapAnchorBlock: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
    };
}

function tokenCard(tokenId: string): TokenCard {
    return {
        tokenId,
        name: `Token ${tokenId}`,
        image: null,
        listingPrice: null,
        listingCurrency: null,
        attributes: [{ key: "Mode", value: "Terrain" }],
        traitSummary: null,
        hasMetadata: true,
        metadataUpdatedAt: "2026-01-01T00:00:00.000Z",
    };
}

function traitFacet(key: string): TraitFacet {
    return {
        key,
        displayKind: TRAIT_FILTER_DISPLAY_KIND.Set,
        minValue: null,
        maxValue: null,
        values: [{ value: "Terrain", tokenCount: 1 }],
    };
}

function bidBook(bids: PersistedBiddingBidBookRow[]): PersistedBiddingBidBook {
    return {
        state: {
            source: TRADING_BIDDING_BID_BOOK_SOURCE.Orders,
            updatedAt: "2026-01-01T00:00:00Z",
            snapshotRefreshedAtMs: null,
            projectedAt: null,
            rowCount: bids.length,
            durationMs: null,
            lastError: null,
        },
        ownMakerAddress: null,
        bids,
    };
}

function bidRow(
    orderId: string,
    priceWei: string,
    tokenId: string | null = orderId === "token-offer" ? "7" : null,
): PersistedBiddingBidBookRow {
    return {
        orderId,
        source: TRADING_BIDDING_BID_BOOK_SOURCE.Orders,
        scopeKind: tokenId
            ? TRADING_BIDDING_BID_SCOPE_KIND.Token
            : TRADING_BIDDING_BID_SCOPE_KIND.Collection,
        scopeLabel: orderId,
        tokenId,
        scopeTraits: [],
        encodedTokenIds: null,
        maker: "0x2222222222222222222222222222222222222222",
        isOwn: false,
        priceWei,
        quantity: "1",
        currencyAddress: null,
        currencySymbol: null,
        protocolAddress: null,
        validUntil: null,
        placedAt: null,
        snapshotRefreshedAtMs: null,
        seenAt: "2026-01-01T00:00:00Z",
        ownStatus: null,
    };
}
