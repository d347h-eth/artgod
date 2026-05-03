import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { TRADING_BIDDING_BID_SCOPE_KIND } from "../types/trading.js";
import {
    inferOpenSeaNftSelectionKind,
    isOpenSeaCollectionWideOffer,
    normalizeOpenSeaOfferTraitCriteria,
    parseOpenSeaBiddingOffer,
} from "./open-sea-bidding-offers.js";

const WETH_ADDRESS = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const COLLECTION_ADDRESS = "0xcollection";
const MAKER_ADDRESS = "0xmaker";
const PROTOCOL_ADDRESS = "0xprotocol";

function makeSnapshotOffer(params: {
    orderHash: string;
    maker: string;
    priceWei: string;
    criteria: unknown;
    itemType?: number;
    collectionAddress?: string;
}) {
    return {
        order_hash: params.orderHash,
        maker: { address: params.maker },
        protocol_data: {
            parameters: {
                offerer: params.maker,
                offer: [
                    {
                        token: WETH_ADDRESS,
                        startAmount: params.priceWei,
                    },
                ],
                consideration: [
                    {
                        itemType: params.itemType ?? 4,
                        token: params.collectionAddress ?? COLLECTION_ADDRESS,
                        startAmount: "1",
                    },
                ],
            },
        },
        criteria: params.criteria,
    };
}

describe("OpenSea bidding offer parser", () => {
    it("preserves direct lookup parsing from the bidder service specs", () => {
        const parsed = parseOpenSeaBiddingOffer(
            {
                order_hash: "0xhash",
                protocol_data: {
                    parameters: {
                        offerer: MAKER_ADDRESS,
                        offer: [
                            {
                                token: WETH_ADDRESS,
                                amount: "1000000000000000000",
                            },
                        ],
                        consideration: [
                            {
                                token: COLLECTION_ADDRESS,
                                identifierOrCriteria: "123",
                                amount: "1",
                                itemType: 2,
                            },
                        ],
                    },
                },
                protocol_address: PROTOCOL_ADDRESS,
                price: {
                    value: "1000000000000000000",
                    decimals: 18,
                    currency: "WETH",
                },
                status: "ACTIVE",
            },
            {
                collectionAddress: COLLECTION_ADDRESS,
                wethAddress: WETH_ADDRESS,
                discoverySource: "stateRecovery",
            },
        );

        assert.ok(parsed);
        assert.equal(parsed.id, "0xhash");
        assert.equal(parsed.maker, MAKER_ADDRESS);
        assert.equal(parsed.price, 1000000000000000000n);
        assert.equal(parsed.protocolAddress, PROTOCOL_ADDRESS);
        assert.equal(parsed.offerScope, "item");
        assert.equal(parsed.discoverySource, "stateRecovery");
        assert.equal(parsed.priceSource, "protocol.offer");
        assert.equal(parsed.quantity, 1n);
        assert.equal(parsed.bidScope.kind, TRADING_BIDDING_BID_SCOPE_KIND.Token);
        assert.equal(parsed.bidScope.label, "#123");
        assert.equal(parsed.bidScope.tokenId, "123");
    });

    it("preserves maker token lookup parsing from currentPrice WETH orders", () => {
        const parsed = parseOpenSeaBiddingOffer(
            {
                orderHash: "0xhash",
                maker: { address: MAKER_ADDRESS },
                protocolAddress: PROTOCOL_ADDRESS,
                currentPrice: "1000000000000000000",
                created_date: "2026-04-26T14:44:41.397Z",
                closing_date: "2026-04-27T14:44:41.397Z",
                paymentToken: WETH_ADDRESS,
            },
            {
                collectionAddress: COLLECTION_ADDRESS,
                wethAddress: WETH_ADDRESS,
                discoverySource: "itemOffers",
            },
        );

        assert.ok(parsed);
        assert.equal(parsed.id, "0xhash");
        assert.equal(parsed.maker, MAKER_ADDRESS);
        assert.equal(parsed.price, 1000000000000000000n);
        assert.equal(parsed.createdAt, "2026-04-26T14:44:41Z");
        assert.equal(parsed.expirationTime, 1777301081);
        assert.equal(parsed.protocolAddress, PROTOCOL_ADDRESS);
        assert.equal(parsed.offerScope, "item");
        assert.equal(parsed.discoverySource, "itemOffers");
        assert.equal(parsed.priceSource, "currentPrice");
    });

    it("trims oversized trait text before creating stored bid-book labels", () => {
        const longValue = "x".repeat(140);
        const parsed = parseOpenSeaBiddingOffer(
            makeSnapshotOffer({
                orderHash: "0xlong-trait",
                maker: "0xother",
                priceWei: "100000000000000000",
                criteria: {
                    traits: [{ type: "Dynamic", value: longValue }],
                },
            }),
            {
                collectionAddress: COLLECTION_ADDRESS,
                wethAddress: WETH_ADDRESS,
            },
        );

        assert.ok(parsed);
        assert.equal(parsed.bidScope.traits[0]?.value.length, 96);
        assert.equal(parsed.bidScope.traits[0]?.value.endsWith("..."), true);
        assert.equal(parsed.bidScope.label.length, "Dynamic=".length + 96);
    });

    it("preserves collection-wide snapshot offer semantics from bidder tests", () => {
        const rawOffer = makeSnapshotOffer({
            orderHash: "0xcollectionwide",
            maker: "0xother",
            priceWei: "100000000000000000",
            criteria: { encoded_token_ids: "*" },
        });

        const parsed = parseOpenSeaBiddingOffer(rawOffer, {
            collectionAddress: COLLECTION_ADDRESS,
            wethAddress: WETH_ADDRESS,
        });

        assert.ok(parsed);
        assert.equal(parsed.id, "0xcollectionwide");
        assert.equal(parsed.price, 100000000000000000n);
        assert.equal(parsed.offerScope, "collection");
        assert.equal(parsed.bidScope.kind, TRADING_BIDDING_BID_SCOPE_KIND.Collection);
        assert.equal(parsed.bidScope.label, "collection");
        assert.equal(parsed.bidScope.encodedTokenIds, "*");
        assert.equal(isOpenSeaCollectionWideOffer(rawOffer), true);
        assert.equal(
            inferOpenSeaNftSelectionKind(rawOffer, COLLECTION_ADDRESS),
            "criteria",
        );
    });

    it("preserves trait snapshot offer semantics from bidder tests", () => {
        const rawOffer = makeSnapshotOffer({
            orderHash: "0xsingle-trait",
            maker: "0xother",
            priceWei: "100000000000000000",
            criteria: {
                encoded_token_ids: "100,123,456",
                traits: [{ type: "Zone", value: "8" }],
            },
        });

        const parsed = parseOpenSeaBiddingOffer(rawOffer, {
            collectionAddress: COLLECTION_ADDRESS,
            wethAddress: WETH_ADDRESS,
            discoverySource: "traitOffers",
        });

        assert.ok(parsed);
        assert.equal(parsed.id, "0xsingle-trait");
        assert.equal(parsed.offerScope, "trait");
        assert.equal(parsed.discoverySource, "traitOffers");
        assert.equal(parsed.bidScope.kind, TRADING_BIDDING_BID_SCOPE_KIND.Trait);
        assert.equal(parsed.bidScope.label, "Zone=8");
        assert.deepEqual(parsed.bidScope.traits, [{ type: "Zone", value: "8" }]);
        assert.equal(parsed.bidScope.encodedTokenIds, "100,123,456");
        assert.equal(isOpenSeaCollectionWideOffer(rawOffer), false);
    });

    it("preserves multi-trait normalization from bidder tests", () => {
        const rawCriteria = {
            traits: [
                { type: "Zone", value: "8" },
                { type: "Biome", value: "53" },
            ],
        };
        const parsed = parseOpenSeaBiddingOffer(
            makeSnapshotOffer({
                orderHash: "0xmulti-trait",
                maker: "0xother",
                priceWei: "200000000000000000",
                criteria: rawCriteria,
            }),
            {
                collectionAddress: COLLECTION_ADDRESS,
                wethAddress: WETH_ADDRESS,
            },
        );

        assert.ok(parsed);
        assert.equal(parsed.bidScope.kind, TRADING_BIDDING_BID_SCOPE_KIND.Trait);
        assert.equal(parsed.bidScope.label, "Zone=8 + Biome=53");
        assert.deepEqual(normalizeOpenSeaOfferTraitCriteria(rawCriteria), [
            { type: "Zone", value: "8" },
            { type: "Biome", value: "53" },
        ]);
    });

    it("normalizes OpenSea stream trait criteria into shared bidder traits", () => {
        const rawOffer = {
            ...makeSnapshotOffer({
                orderHash: "0xstream-traits",
                maker: "0xother",
                priceWei: "310000000000000000",
                criteria: undefined,
            }),
            trait_criteria: { trait_type: "Biome", trait_name: "81" },
            trait_criteria_list: [
                { trait_type: "Biome", trait_name: "81" },
                { trait_type: "Mode", trait_name: "Terrain" },
            ],
        };

        const parsed = parseOpenSeaBiddingOffer(rawOffer, {
            collectionAddress: COLLECTION_ADDRESS,
            wethAddress: WETH_ADDRESS,
        });

        assert.ok(parsed);
        assert.equal(parsed.offerScope, "trait");
        assert.equal(parsed.bidScope.kind, TRADING_BIDDING_BID_SCOPE_KIND.Trait);
        assert.equal(parsed.bidScope.label, "Biome=81 + Mode=Terrain");
        assert.deepEqual(parsed.bidScope.traits, [
            { type: "Biome", value: "81" },
            { type: "Mode", value: "Terrain" },
        ]);
    });

    it("preserves explicit item offer detection from bidder snapshot tests", () => {
        const rawOffer = makeSnapshotOffer({
            orderHash: "0xexplicit-item",
            maker: "0xother",
            priceWei: "500000000000000000",
            criteria: undefined,
            itemType: 2,
        });

        const parsed = parseOpenSeaBiddingOffer(rawOffer, {
            collectionAddress: COLLECTION_ADDRESS,
            wethAddress: WETH_ADDRESS,
        });

        assert.ok(parsed);
        assert.equal(parsed.offerScope, "item");
        assert.equal(parsed.bidScope.kind, TRADING_BIDDING_BID_SCOPE_KIND.Unknown);
        assert.equal(
            inferOpenSeaNftSelectionKind(rawOffer, COLLECTION_ADDRESS),
            "item",
        );
        assert.equal(isOpenSeaCollectionWideOffer(rawOffer), false);
    });

    it("parses exact numeric_traits and partial quantity as the new OpenSea bid-book regression", () => {
        const parsed = parseOpenSeaBiddingOffer(
            {
                order_hash: "0xnumeric-trait-partial",
                protocol_address:
                    "0x0000000000000068f116a894984e2db1123eb395",
                remaining_quantity: 2,
                protocol_data: {
                    parameters: {
                        offerer: "0xd1acbe05a739c855f2c54f42f0f1e3df662da56d",
                        offer: [
                            {
                                itemType: 1,
                                token: WETH_ADDRESS,
                                identifierOrCriteria: "0",
                                startAmount: "620000000000000000",
                                endAmount: "620000000000000000",
                            },
                        ],
                        consideration: [
                            {
                                itemType: 4,
                                token: COLLECTION_ADDRESS,
                                identifierOrCriteria:
                                    "113703377976973476812273708665395356499261988770439230068849221413098206214838",
                                startAmount: "2",
                                endAmount: "2",
                                recipient:
                                    "0xd1acbe05a739c855f2c54f42f0f1e3df662da56d",
                            },
                            {
                                itemType: 1,
                                token: WETH_ADDRESS,
                                identifierOrCriteria: "0",
                                startAmount: "6200000000000000",
                                endAmount: "6200000000000000",
                                recipient:
                                    "0x0000a26b00c1f0df003000390027140000faa719",
                            },
                        ],
                        orderType: 3,
                        endTime: "1789097938",
                    },
                },
                criteria: {
                    collection: { slug: "terraforms" },
                    contract: { address: COLLECTION_ADDRESS },
                    trait: null,
                    traits: null,
                    numeric_traits: [{ type: "Biome", min: 42, max: 42 }],
                    encoded_token_ids: "30,314,5108:5109",
                },
            },
            {
                collectionAddress: COLLECTION_ADDRESS,
                wethAddress: WETH_ADDRESS,
            },
        );

        assert.ok(parsed);
        assert.equal(parsed.offerScope, "trait");
        assert.equal(parsed.price, 310000000000000000n);
        assert.equal(parsed.priceSource, "protocol.offer/unit");
        assert.equal(parsed.quantity, 2n);
        assert.equal(parsed.expirationTime, 1789097938);
        assert.equal(parsed.bidScope.kind, TRADING_BIDDING_BID_SCOPE_KIND.Trait);
        assert.equal(parsed.bidScope.label, "Biome=42");
        assert.deepEqual(parsed.bidScope.traits, [
            { type: "Biome", value: "42" },
        ]);
        assert.equal(parsed.bidScope.encodedTokenIds, "30,314,5108:5109");
    });
});
