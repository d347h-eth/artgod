import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import {
    TRADING_BIDDING_BID_BOOK_SOURCE,
    TRADING_BIDDING_BID_SCOPE_KIND,
    type TokenCard,
} from "@artgod/shared/types";
import {
    COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
    type PersistedBiddingBidBookRow,
} from "./bidding-bid-book.js";
import {
    buildPersistedTokenOfferCards,
    buildTokenOfferGroups,
    sortTokenIdsByTopOffer,
    tokenMatchesTraitFilters,
    tokenMatchesTraitFiltersWithJoinMode,
} from "./bidding-token-offer-cards.js";

describe("bidding token offer cards", () => {
    it("groups only non-muted token offers and sorts offers by price descending", () => {
        const offersByTokenId = buildTokenOfferGroups({
            collectionBids: [bid({ orderId: "collection-top", priceWei: "100" })],
            tokenBids: [
                bid({
                    orderId: "token-1-low",
                    scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
                    tokenId: "1",
                    priceWei: "9",
                }),
                bid({
                    orderId: "token-1-top",
                    scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
                    tokenId: "1",
                    priceWei: "12",
                }),
                bid({
                    orderId: "token-1-tie-a",
                    scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
                    tokenId: "1",
                    priceWei: "10",
                }),
                bid({
                    orderId: "token-1-tie-b",
                    scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
                    tokenId: "1",
                    priceWei: "10",
                }),
                bid({
                    orderId: "token-2",
                    scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
                    tokenId: "2",
                    priceWei: "11",
                }),
                bid({
                    orderId: "missing-token-id",
                    scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
                    tokenId: null,
                    priceWei: "99",
                }),
                bid({
                    orderId: "collection-row",
                    scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Collection,
                    tokenId: "3",
                    priceWei: "99",
                }),
            ],
        });

        assert.deepEqual([...offersByTokenId.keys()], ["1", "2"]);
        assert.deepEqual(
            offersByTokenId.get("1")?.map((offer) => offer.orderId),
            ["token-1-top", "token-1-tie-a", "token-1-tie-b"],
        );
    });

    it("sorts token IDs by top offer and uses numeric token IDs as tie-breakers", () => {
        const offersByTokenId = new Map<string, PersistedBiddingBidBookRow[]>([
            ["10", [bid({ tokenId: "10", priceWei: "20" })]],
            ["2", [bid({ tokenId: "2", priceWei: "20" })]],
            ["1", [bid({ tokenId: "1", priceWei: "21" })]],
        ]);

        assert.deepEqual(sortTokenIdsByTopOffer(offersByTokenId), [
            "1",
            "2",
            "10",
        ]);
    });

    it("builds cards only for hydrated tokens matching selected traits and ranges", () => {
        const offersByTokenId = new Map<string, PersistedBiddingBidBookRow[]>([
            ["1", [bid({ tokenId: "1", priceWei: "20" })]],
            ["2", [bid({ tokenId: "2", priceWei: "19" })]],
            ["3", []],
        ]);

        const cards = buildPersistedTokenOfferCards({
            tokenCards: [
                tokenCard("1", [
                    { key: "Mode", value: "Terrain" },
                    { key: "Level", value: "42" },
                ]),
                tokenCard("2", [
                    { key: "Mode", value: "Origin" },
                    { key: "Level", value: "42" },
                ]),
                tokenCard("3", [
                    { key: "Mode", value: "Terrain" },
                    { key: "Level", value: "42" },
                ]),
            ],
            offersByTokenId,
            selectedTraits: [{ key: "Mode", value: "Terrain" }],
            selectedTraitRanges: [
                { key: "Level", fromValue: "40", toValue: "45" },
            ],
            traitSummaryTemplate: "{Mode}/{Level}",
        });

        assert.equal(cards.length, 1);
        assert.equal(cards[0]?.token.tokenId, "1");
        assert.equal(cards[0]?.token.traitSummary, "Terrain/42");
        assert.equal(cards[0]?.persistedOffers[0]?.orderId, "order-1");
    });

    it("applies AND/OR trait matching and rejects non-numeric range values", () => {
        const token = tokenCard("1", [
            { key: "Mode", value: "Terrain" },
            { key: "Level", value: "unknown" },
        ]);

        assert.equal(
            tokenMatchesTraitFilters(
                token,
                [{ key: "Mode", value: "Terrain" }],
                [{ key: "Level", fromValue: "1", toValue: "99" }],
            ),
            false,
        );
        assert.equal(
            tokenMatchesTraitFiltersWithJoinMode(
                token,
                [{ key: "Mode", value: "Terrain" }],
                [{ key: "Level", fromValue: "1", toValue: "99" }],
                COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
            ),
            true,
        );
        assert.equal(
            tokenMatchesTraitFiltersWithJoinMode(
                token,
                [],
                [],
                COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
            ),
            true,
        );
    });
});

function bid(
    overrides: Partial<PersistedBiddingBidBookRow>,
): PersistedBiddingBidBookRow {
    return {
        orderId: "order-1",
        source: TRADING_BIDDING_BID_BOOK_SOURCE.Orders,
        scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Collection,
        scopeLabel: "collection",
        tokenId: null,
        scopeTraits: [],
        encodedTokenIds: null,
        maker: "0x1111111111111111111111111111111111111111",
        isOwn: false,
        priceWei: "1",
        quantity: "1",
        currencyAddress: null,
        currencySymbol: null,
        protocolAddress: null,
        validUntil: null,
        placedAt: null,
        snapshotRefreshedAtMs: null,
        seenAt: null,
        ownStatus: null,
        ...overrides,
    };
}

function tokenCard(
    tokenId: string,
    attributes: TokenCard["attributes"],
): TokenCard {
    return {
        tokenId,
        name: `Token ${tokenId}`,
        image: null,
        traitSummary: null,
        hasMetadata: true,
        metadataUpdatedAt: null,
        listingPrice: null,
        listingCurrency: null,
        attributes,
    };
}
