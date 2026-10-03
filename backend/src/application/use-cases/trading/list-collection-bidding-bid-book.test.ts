import { describe, expect, it } from "vitest";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import type { ApmPort, SpanAttributes } from "@artgod/shared/observability/apm";
import {
    COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER,
    COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTERS,
    COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER,
    TRADING_BIDDING_BID_BOOK_SOURCE,
    TRADING_BIDDING_BID_SCOPE_KIND,
    TRADING_BOT_LIFECYCLE_STATUS,
    TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE,
    TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND,
    TRADING_BIDDING_BID_BOOK_OWN_STATE,
    TRADING_BIDDING_JOB_RUNTIME_BID_POSITION,
    TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT,
    TRADING_JOB_STATUS,
} from "@artgod/shared/types";
import { TRAIT_FILTER_DISPLAY_KIND } from "@artgod/shared/types";
import {
    COLLECTION_MEDIA_MODE_OPTIONS,
    COLLECTION_MEDIA_MODES,
} from "@artgod/shared/extensions";
import type {
    ChainRecord,
    CollectionListItem,
    CollectionMediaState,
    TokenCard,
    TraitFacet,
} from "@artgod/shared/types/browse";
import {
    COLLECTION_BIDDING_BID_SCOPE_FILTER,
    COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
    exactBidBookRowPrice,
    marketBidMaterialization,
    type BiddingBidBookRepositoryPort,
    type PersistedBiddingBidBook,
    type PersistedBiddingBidBookRow,
    type PersistedBiddingMarketBidRow,
} from "./bidding-bid-book.js";
import { BIDDING_SPAN_ATTRIBUTE } from "./bidding-observability.js";
import {
    ListCollectionBiddingBidBookUseCase,
    type ListCollectionBiddingBidBookInput,
} from "./list-collection-bidding-bid-book.js";

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
    it.each(COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTERS)(
        "rejects collection-scoped state filter %s before reading",
        (ownStateFilter) => {
            const useCase = buildUseCase({
                listCollectionBidBook: () => {
                    throw new Error("repository must not be called");
                },
                listTokenBidBook: () => bidBook([]),
            });

            expect(() =>
                useCase.listCollectionBiddingBidBook(
                    biddingInput({
                        scopeFilter:
                            COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection,
                        ownStateFilter,
                    }),
                ),
            ).toThrow(ReadModelBadRequestError);
        },
    );

    it("rejects conflicting maker and ownership filters before reading", () => {
        const useCase = buildUseCase({
            listCollectionBidBook: () => {
                throw new Error("repository must not be called");
            },
            listTokenBidBook: () => bidBook([]),
        });

        expect(() =>
            useCase.listCollectionBiddingBidBook(
                biddingInput({
                    includeOwnJobContext: true,
                    makerAddress: "0x1111111111111111111111111111111111111111",
                    ownershipFilter:
                        COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER.Own,
                }),
            ),
        ).toThrow("Maker and ownership filters cannot be combined");
    });

    it("rejects own filtering when local job context is unavailable", () => {
        const useCase = buildUseCase({
            listCollectionBidBook: () => {
                throw new Error("repository must not be called");
            },
            listTokenBidBook: () => bidBook([]),
        });

        expect(() =>
            useCase.listCollectionBiddingBidBook(
                biddingInput({
                    includeOwnJobContext: false,
                    ownershipFilter:
                        COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER.Own,
                }),
            ),
        ).toThrow("Own bids are unavailable in public bid-book reads");
    });

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
                getCollectionMediaState: () => media(),
                listCollectionTraitFacets: () => [traitFacet("Mode")],
                listCollectionTokenCardsByIds: () => [tokenCard("7")],
                countMarketplaceBiddingSupportedTokensByIds: () => 1,
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
            includeOwnJobContext: false,
            scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Token,
            traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
            traits: [{ key: "Mode", value: "Terrain" }],
            traitRanges: [],
            makerAddress: "0x1111111111111111111111111111111111111111",
            mediaMode: COLLECTION_MEDIA_MODES.Snapshot,
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
            "backend.bidding.collection_bid_book.media",
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
                        [BIDDING_SPAN_ATTRIBUTE.TokenOfferCardsTotalOffers]: 1,
                    }),
                }),
            ]),
        );
    });

    it("paginates unfiltered token offers before hydrating token cards", () => {
        const hydratedTokenIds: string[][] = [];
        const repository: BiddingBidBookRepositoryPort = {
            listCollectionBidBook: (params) =>
                params.scopeFilter === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token
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
                getCollectionMediaState: () => media(),
                listCollectionTraitFacets: () => [],
                listCollectionTokenCardsByIds: (params) => {
                    hydratedTokenIds.push(params.tokenIds);
                    return params.tokenIds.map((tokenId) => tokenCard(tokenId));
                },
                countMarketplaceBiddingSupportedTokensByIds: () => 2,
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
            includeOwnJobContext: false,
            scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Token,
            traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And,
            traits: [],
            traitRanges: [],
            limit: 2,
        });

        expect(hydratedTokenIds).toEqual([["1", "2"]]);
        expect(output.tokenOfferCards.totalItems).toBe(3);
        expect(
            output.tokenOfferCards.marketplaceBiddingSupportedTotalItems,
        ).toBe(2);
        expect(output.tokenOfferCards.totalOffers).toBe(3);
        expect(
            output.tokenOfferCards.items.map((card) => card.tokenId),
        ).toEqual(["1", "2"]);
        expect(output.bidBook.bids.map((bid) => bid.orderId)).toEqual([
            "token-1-offer",
            "token-2-offer",
        ]);
    });

    it("applies the shared collection bid floor to trait bid-book rows", () => {
        const bidBookScopes: string[] = [];
        const repository: BiddingBidBookRepositoryPort = {
            listCollectionBidBook: (params) => {
                bidBookScopes.push(params.scopeFilter);
                if (
                    params.scopeFilter ===
                    COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits
                ) {
                    return bidBook([
                        traitBidRow("trait-low", "9"),
                        traitBidRow("trait-edge", "10"),
                        traitBidRow("trait-top", "11"),
                        traitBidRow("trait-own-low", "1", true),
                    ]);
                }
                return bidBook([bidRow("collection-floor", "100")]);
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
                getCollectionMediaState: () => media(),
                listCollectionTraitFacets: () => [],
                listCollectionTokenCardsByIds: () => [],
                countMarketplaceBiddingSupportedTokensByIds: () => 0,
            },
            {
                getTraitFilterPresentationState: () => ({
                    effectiveConfig: {
                        rangeKeys: [],
                    },
                }),
                getTokenCardTraitSummaryTemplateState: () => ({
                    effectiveConfig: {
                        template: "",
                    },
                }),
            },
            repository,
        );

        const output = useCase.listCollectionBiddingBidBook({
            chainRef: "ethereum",
            collectionRef: "terraforms",
            includeOwnJobContext: true,
            scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits,
            traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
            traits: [],
            traitRanges: [],
            limit: 25,
        });

        expect(bidBookScopes).toEqual(["traits", "collection"]);
        expect(output.bidBook.bids.map((bid) => bid.orderId)).toEqual([
            "trait-edge",
            "trait-top",
            "trait-own-low",
        ]);
    });
});

describe("own-state counts and filtering", () => {
    const position = TRADING_BIDDING_JOB_RUNTIME_BID_POSITION;
    const constraint = TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT;

    function ownMarket(
        orderId: string,
        tokenId: string,
        state: (typeof position)[keyof typeof position],
        constraints: Array<(typeof constraint)[keyof typeof constraint]> = [],
    ): PersistedBiddingBidBookRow {
        return {
            ...bidRow(orderId, "100", tokenId),
            isOwn: true,
            ownStatus: { position: state, constraints, job: null },
        };
    }

    it.each([
        COLLECTION_BIDDING_BID_SCOPE_FILTER.Token,
        COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits,
    ])(
        "keeps paused cancellation and unknown rows reachable in %s scope",
        (scopeFilter) => {
            const phase = TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE;
            const rows: PersistedBiddingBidBookRow[] = [
                {
                    ...bidRow("paused-cancellation", "100", "1"),
                    maker: null,
                    isOwn: true,
                    materialization: {
                        kind: TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent,
                        jobId: "paused-job",
                        status: TRADING_JOB_STATUS.Paused,
                        phase: phase.CancelFailed,
                    },
                },
                {
                    ...bidRow("archived-cancellation", "100", "2"),
                    maker: null,
                    isOwn: true,
                    materialization: {
                        kind: TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent,
                        jobId: "archived-job",
                        status: TRADING_JOB_STATUS.Archived,
                        phase: phase.Canceling,
                    },
                },
                { ...bidRow("unreported-own-order", "100", "3"), isOwn: true },
            ];
            const scopedRows = rows.map((row) => ({
                ...row,
                scopeKind:
                    scopeFilter === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token
                        ? TRADING_BIDDING_BID_SCOPE_KIND.Token
                        : TRADING_BIDDING_BID_SCOPE_KIND.Trait,
                tokenId:
                    scopeFilter === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token
                        ? row.tokenId
                        : null,
                scopeTraits:
                    scopeFilter === COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits
                        ? [{ type: "Mode", value: "Terrain" }]
                        : [],
            }));
            const useCase = buildUseCase(
                {
                    listCollectionBidBook: (input) =>
                        bidBook(
                            input.scopeFilter === scopeFilter ? scopedRows : [],
                        ),
                    listTokenBidBook: () => bidBook([]),
                },
                ({ tokenIds }) => tokenIds.map(tokenCard),
            );
            for (const [ownStateFilter, orderId] of [
                [phase.Paused, "paused-cancellation"],
                [phase.CancelFailed, "paused-cancellation"],
                [phase.Canceling, "archived-cancellation"],
                [
                    TRADING_BIDDING_BID_BOOK_OWN_STATE.Unknown,
                    "unreported-own-order",
                ],
            ] as const) {
                const result = useCase.listCollectionBiddingBidBook(
                    biddingInput({ scopeFilter, ownStateFilter, limit: 1 }),
                );
                expect(result.bidBook.bids.map((row) => row.orderId)).toEqual([
                    orderId,
                ]);
                expect(result.ownBidStateCounts?.total).toBe(3);
                expect(result.ownBidStateCounts?.states[ownStateFilter]).toBe(
                    1,
                );
            }
            const active = useCase.listCollectionBiddingBidBook(
                biddingInput({
                    scopeFilter,
                    ownStateFilter:
                        COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER.Active,
                    limit: 1,
                }),
            );
            expect(
                active.ownBidStateCounts?.states[
                    COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER.Active
                ],
            ).toBe(2);
            expect(active.ownBidStateCounts?.states[phase.Paused]).toBe(1);
            expect(active.bidBook.bids.map((row) => row.orderId)).toEqual(
                scopeFilter === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token
                    ? ["archived-cancellation"]
                    : ["archived-cancellation", "unreported-own-order"],
            );
            if (scopeFilter === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token) {
                expect(active.tokenOfferCards.totalItems).toBe(2);
                expect(active.tokenOfferCards.totalOffers).toBe(2);
            }
        },
    );

    it.each([
        COLLECTION_BIDDING_BID_SCOPE_FILTER.Token,
        COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits,
    ])(
        "selects own states independently of ownership in %s groups",
        (scopeFilter) => {
            const rows = [
                ownMarket("losing", "1", position.Losing),
                ownMarket("winning-same-group", "1", position.Winning),
                bidRow("opponent-matched", "200", "1"),
                ownMarket("winning-other-group", "2", position.Winning),
                bidRow("opponent-other-group", "300", "2"),
                bidRow("opponent-only-group", "400", "3"),
            ].map((row) => {
                if (scopeFilter === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token)
                    return row;
                const traits =
                    row.tokenId === "1"
                        ? [
                              { type: "Mode", value: "Terrain" },
                              { type: "Biome", value: "42" },
                          ]
                        : [
                              {
                                  type: "Biome",
                                  value: row.tokenId === "2" ? "42" : "7",
                              },
                          ];
                return {
                    ...row,
                    scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Trait,
                    tokenId: null,
                    scopeTraits: row.isOwn ? traits : [...traits].reverse(),
                };
            });
            const useCase = buildUseCase(
                {
                    listCollectionBidBook: (input) =>
                        bidBook(
                            input.scopeFilter === scopeFilter
                                ? rows.filter(
                                      (row) =>
                                          !input.ownershipFilter || row.isOwn,
                                  )
                                : [],
                        ),
                    listTokenBidBook: () => bidBook([]),
                },
                ({ tokenIds }) => tokenIds.map(tokenCard),
            );
            for (const ownershipFilter of [
                null,
                COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER.Own,
            ]) {
                const result = useCase.listCollectionBiddingBidBook(
                    biddingInput({
                        scopeFilter,
                        ownershipFilter,
                        ownStateFilter: position.Losing,
                        limit: 1,
                    }),
                );
                expect(result.bidBook.bids.map((row) => row.orderId)).toEqual(
                    ownershipFilter
                        ? ["losing"]
                        : scopeFilter ===
                            COLLECTION_BIDDING_BID_SCOPE_FILTER.Token
                          ? ["opponent-matched", "losing"]
                          : ["losing", "opponent-matched"],
                );
                expect(result.ownBidStateCounts?.total).toBe(3);
                expect(result.ownBidStateCounts?.states[position.Losing]).toBe(
                    1,
                );
                if (scopeFilter === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token) {
                    expect(result.tokenOfferCards.totalItems).toBe(1);
                    expect(result.tokenOfferCards.totalOffers).toBe(
                        ownershipFilter ? 1 : 2,
                    );
                } else {
                    expect(result.bidBook.state.rowCount).toBe(
                        ownershipFilter ? 1 : 2,
                    );
                }
                const empty = useCase.listCollectionBiddingBidBook(
                    biddingInput({
                        scopeFilter,
                        ownershipFilter,
                        ownStateFilter: position.Draw,
                    }),
                );
                expect(empty.bidBook.bids).toEqual([]);
                expect(empty.ownBidStateCounts).toEqual(
                    result.ownBidStateCounts,
                );
            }
        },
    );

    it("ranks and paginates matched tokens with their retained opponent offers", () => {
        const rows = [
            ownMarket("losing-1", "1", position.Losing),
            {
                ...ownMarket("losing-2", "2", position.Losing),
                price: exactBidBookRowPrice("200"),
            },
            bidRow("opponent-matched", "300", "1"),
            bidRow("opponent-unrelated", "400", "3"),
        ];
        const useCase = buildUseCase(
            {
                listCollectionBidBook: (input) =>
                    bidBook(
                        input.scopeFilter ===
                            COLLECTION_BIDDING_BID_SCOPE_FILTER.Token
                            ? rows.filter(
                                  (row) => !input.ownershipFilter || row.isOwn,
                              )
                            : [],
                    ),
                listTokenBidBook: () => bidBook([]),
            },
            ({ tokenIds }) => tokenIds.map(tokenCard),
        );
        const input = biddingInput({
            scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Token,
            ownStateFilter: position.Losing,
            limit: 1,
        });
        const first = useCase.listCollectionBiddingBidBook(input);
        expect(first.tokenOfferCards.items.map((card) => card.tokenId)).toEqual(
            ["1"],
        );
        expect(first.tokenOfferCards.totalItems).toBe(2);
        expect(first.tokenOfferCards.totalOffers).toBe(3);
        const second = useCase.listCollectionBiddingBidBook({
            ...input,
            cursor: first.tokenOfferCards.nextCursor,
        });
        expect(
            second.tokenOfferCards.items.map((card) => card.tokenId),
        ).toEqual(["2"]);
        expect(second.ownBidStateCounts).toEqual(first.ownBidStateCounts);
        const ownOnly = useCase.listCollectionBiddingBidBook({
            ...input,
            ownershipFilter: COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER.Own,
        });
        expect(
            ownOnly.tokenOfferCards.items.map((card) => card.tokenId),
        ).toEqual(["2"]);
        expect(ownOnly.tokenOfferCards.totalOffers).toBe(2);
        expect(ownOnly.ownBidStateCounts).toEqual(first.ownBidStateCounts);
    });

    it("counts across pages and filters before token hydration and pagination", () => {
        const rows = [
            ownMarket("winning", "1", position.Winning, [constraint.Floor]),
            ownMarket("losing", "2", position.Losing, [constraint.Ceiling]),
            ownMarket("draw", "3", position.Draw),
            bidRow("opponent", "200", "4"),
        ];
        const hydratedIds: string[][] = [];
        const useCase = buildUseCase(
            {
                listCollectionBidBook: ({ scopeFilter }) =>
                    bidBook(
                        scopeFilter ===
                            COLLECTION_BIDDING_BID_SCOPE_FILTER.Token
                            ? rows
                            : [],
                    ),
                listTokenBidBook: () => bidBook([]),
            },
            ({ tokenIds }) => {
                hydratedIds.push(tokenIds);
                return tokenIds.map(tokenCard);
            },
        );
        const first = useCase.listCollectionBiddingBidBook(
            biddingInput({
                scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Token,
                limit: 1,
            }),
        );
        expect(first.ownBidStateCounts?.total).toBe(3);
        expect(first.ownBidStateCounts?.states[position.Losing]).toBe(1);
        expect(hydratedIds).toEqual([["4"]]);
        const filtered = useCase.listCollectionBiddingBidBook(
            biddingInput({
                scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Token,
                ownStateFilter: position.Losing,
                limit: 1,
            }),
        );
        expect(
            filtered.tokenOfferCards.items.map((card) => card.tokenId),
        ).toEqual(["2"]);
        expect(filtered.tokenOfferCards.totalItems).toBe(1);
        expect(filtered.tokenOfferCards.totalOffers).toBe(1);
        expect(filtered.ownBidStateCounts).toEqual(first.ownBidStateCounts);
        expect(hydratedIds).toEqual([["4"], ["2"]]);
        const next = useCase.listCollectionBiddingBidBook(
            biddingInput({
                scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Token,
                cursor: first.tokenOfferCards.nextCursor,
                limit: 1,
            }),
        );
        expect(next.ownBidStateCounts).toEqual(first.ownBidStateCounts);
    });

    it("applies token metadata filters before counting, and excludes nonmatching offers within each card", () => {
        const rows = [
            ownMarket("winning", "1", position.Winning),
            ownMarket("losing", "1", position.Losing, [constraint.Ceiling]),
            bidRow("opponent-matched", "200", "1"),
            ownMarket("excluded", "2", position.Losing),
        ];
        const useCase = buildUseCase(
            {
                listCollectionBidBook: ({ scopeFilter }) =>
                    bidBook(
                        scopeFilter ===
                            COLLECTION_BIDDING_BID_SCOPE_FILTER.Token
                            ? rows
                            : [],
                    ),
                listTokenBidBook: () => bidBook([]),
            },
            ({ tokenIds }) =>
                tokenIds.map((id) => ({
                    ...tokenCard(id),
                    attributes: [
                        {
                            key: "Mode",
                            value: id === "1" ? "Terrain" : "Origin",
                        },
                    ],
                })),
        );
        const result = useCase.listCollectionBiddingBidBook(
            biddingInput({
                scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Token,
                traits: [{ key: "Mode", value: "Terrain" }],
                ownStateFilter: constraint.Ceiling,
                limit: 1,
            }),
        );
        expect(result.ownBidStateCounts?.total).toBe(2);
        expect(result.ownBidStateCounts?.states[position.Losing]).toBe(1);
        expect(result.tokenOfferCards.totalOffers).toBe(2);
        expect(
            result.tokenOfferCards.items[0]?.offers.map((bid) => bid.orderId),
        ).toEqual(["opponent-matched", "losing"]);
    });

    it("includes addressless intent, preserves counts for empty matches, and keeps public summaries absent", () => {
        const intent: PersistedBiddingBidBookRow = {
            ...bidRow("queued", "100", "1"),
            maker: null,
            isOwn: true,
            materialization: {
                kind: TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent,
                jobId: "job",
                status: TRADING_JOB_STATUS.Enabled,
                phase: TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Queued,
            },
        };
        const useCase = buildUseCase(
            {
                listCollectionBidBook: ({ scopeFilter }) =>
                    bidBook(
                        scopeFilter ===
                            COLLECTION_BIDDING_BID_SCOPE_FILTER.Token
                            ? [intent, bidRow("opponent", "200", "2")]
                            : [],
                    ),
                listTokenBidBook: () => bidBook([]),
            },
            ({ tokenIds }) => tokenIds.map(tokenCard),
        );
        const queued = useCase.listCollectionBiddingBidBook(
            biddingInput({
                scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Token,
                ownStateFilter: TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Queued,
            }),
        );
        expect(queued.bidBook.bids[0]?.maker.address).toBeNull();
        expect(queued.tokenOfferCards.totalOffers).toBe(1);
        expect(queued.ownBidStateCounts?.total).toBe(1);
        const empty = useCase.listCollectionBiddingBidBook(
            biddingInput({
                scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Token,
                ownStateFilter: position.Losing,
            }),
        );
        expect(empty.bidBook.bids).toEqual([]);
        expect(empty.tokenOfferCards.totalOffers).toBe(0);
        expect(empty.ownBidStateCounts).toEqual(queued.ownBidStateCounts);
        expect(
            useCase.listCollectionBiddingBidBook(
                biddingInput({
                    scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Token,
                    includeOwnJobContext: false,
                }),
            ).ownBidStateCounts,
        ).toBeNull();
        expect(() =>
            useCase.listCollectionBiddingBidBook(
                biddingInput({
                    scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Token,
                    includeOwnJobContext: false,
                    ownStateFilter: position.Losing,
                }),
            ),
        ).toThrow("Own bids are unavailable in public bid-book reads");
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

function buildUseCase(
    repository: BiddingBidBookRepositoryPort,
    tokenReader: ListCollectionBiddingBidBookUseCase["collectionReadPort"]["listCollectionTokenCardsByIds"] = () => [],
): ListCollectionBiddingBidBookUseCase {
    return new ListCollectionBiddingBidBookUseCase(
        1,
        { resolveChainRef: () => chain() },
        {
            resolveCollectionRef: () => collection(),
            getCollectionMediaState: () => media(),
            listCollectionTraitFacets: () => [],
            listCollectionTokenCardsByIds: tokenReader,
            countMarketplaceBiddingSupportedTokensByIds: ({ tokenIds }) =>
                tokenIds.length,
        },
        {
            getTraitFilterPresentationState: () => ({
                effectiveConfig: { rangeKeys: [] },
            }),
            getTokenCardTraitSummaryTemplateState: () => ({
                effectiveConfig: { template: "" },
            }),
        },
        repository,
    );
}

function biddingInput(
    overrides: Partial<ListCollectionBiddingBidBookInput>,
): ListCollectionBiddingBidBookInput {
    return {
        chainRef: "ethereum",
        collectionRef: "terraforms",
        includeOwnJobContext: true,
        scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection,
        traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
        traits: [],
        traitRanges: [],
        limit: 25,
        ...overrides,
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

function media(): CollectionMediaState {
    return {
        selectedMode: COLLECTION_MEDIA_MODES.Snapshot,
        defaultMode: COLLECTION_MEDIA_MODES.Snapshot,
        availableModes: [COLLECTION_MEDIA_MODE_OPTIONS.Snapshot],
        preference: null,
    };
}

function tokenCard(tokenId: string): TokenCard {
    return {
        tokenId,
        marketplaceBiddingSupported: true,
        name: `Token ${tokenId}`,
        image: null,
        animationUrl: null,
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
        values: [
            {
                value: "Terrain",
                tokenCount: 1,
                marketplaceBiddingSupported: true,
            },
        ],
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
        biddingBotStatus: TRADING_BOT_LIFECYCLE_STATUS.Inactive,
        biddingAuthorization: null,
        ownMakerAddress: null,
        bids,
    };
}

function bidRow(
    orderId: string,
    priceWei: string,
    tokenId: string | null = orderId === "token-offer" ? "7" : null,
): PersistedBiddingMarketBidRow {
    return {
        orderId,
        source: TRADING_BIDDING_BID_BOOK_SOURCE.Orders,
        materialization: marketBidMaterialization(),
        scopeKind: tokenId
            ? TRADING_BIDDING_BID_SCOPE_KIND.Token
            : TRADING_BIDDING_BID_SCOPE_KIND.Collection,
        scopeLabel: orderId,
        tokenId,
        scopeTraits: [],
        encodedTokenIds: null,
        maker: "0x2222222222222222222222222222222222222222",
        isOwn: false,
        price: exactBidBookRowPrice(priceWei),
        bidLimits: null,
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

function traitBidRow(
    orderId: string,
    priceWei: string,
    isOwn = false,
): PersistedBiddingMarketBidRow {
    return {
        ...bidRow(orderId, priceWei, null),
        scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Trait,
        scopeLabel: "Mode=Terrain",
        scopeTraits: [{ type: "Mode", value: "Terrain" }],
        isOwn,
    };
}
