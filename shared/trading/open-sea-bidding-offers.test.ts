import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { SEAPORT_ITEM_TYPE } from "../market-data/seaport.js";
import {
    capturedOpenSeaRangedOfferFixtures,
    capturedOpenSeaCambriaRestOffers,
    capturedOpenSeaNumericStreamOffer,
} from "../testing/opensea-offers.js";
import {
    TRADING_BIDDING_BID_SCOPE_KIND,
    TRADING_TRAIT_TEXT_MAX_LENGTH,
} from "../types/trading.js";
import {
    inferOpenSeaNftSelectionKind,
    isOpenSeaCollectionWideOffer,
    normalizeOpenSeaOfferTraitCriteria,
    parseOpenSeaBiddingOffer,
    openSeaEncodedTokenIdsContain,
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
    tokenId?: string;
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
                        itemType: SEAPORT_ITEM_TYPE.Erc20,
                        token: WETH_ADDRESS,
                        startAmount: params.priceWei,
                    },
                ],
                consideration: [
                    {
                        itemType: params.itemType ?? 4,
                        identifierOrCriteria: params.tokenId,
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
    it("keeps captured Cambria numeric bids trait-scoped in REST and the live stream shape", () => {
        for (const { payload, expected } of [
            ...capturedOpenSeaCambriaRestOffers,
            {
                payload: capturedOpenSeaNumericStreamOffer.event.payload,
                expected: capturedOpenSeaNumericStreamOffer.expected,
            },
        ]) {
            const parsed = parseOpenSeaBiddingOffer(payload);
            assert.ok(parsed);
            assert.equal(parsed.offerScope, "trait");
            assert.equal(
                parsed.bidScope.kind,
                TRADING_BIDDING_BID_SCOPE_KIND.Trait,
            );
            assert.deepEqual(parsed.bidScope.traits, expected.traits);
            assert.equal(parsed.price.toString(), expected.unitPriceWei);
            assert.equal(isOpenSeaCollectionWideOffer(payload), false);
        }
    });

    it("preserves stream numeric aliases, exact values, and mixed constraints", () => {
        const payload = capturedOpenSeaNumericStreamOffer.event.payload;
        for (const [field, range] of [
            [
                "numeric_trait_criteria_list",
                { trait_type: "Affinities", min_value: 4, max_value: 5 },
            ],
            [
                "numericTraitCriteriaList",
                { traitType: "Affinities", minValue: 4, maxValue: 5 },
            ],
        ] as const) {
            const base = {
                ...payload,
                numeric_trait_criteria_list: undefined,
                [field]: [range],
            };
            for (const criteria of [
                undefined,
                {},
                { traits: [{ type: "Race", value: "Ghoul" }] },
            ]) {
                const raw = {
                    ...base,
                    criteria,
                    trait_criteria: {
                        trait_type: "Mode",
                        trait_name: "Terrain",
                    },
                };
                assert.deepEqual(
                    parseOpenSeaBiddingOffer(raw)?.bidScope.traits,
                    [
                        ...(criteria && "traits" in criteria
                            ? (criteria.traits ?? [])
                            : []),
                        { type: "Mode", value: "Terrain" },
                        { type: "Affinities", min: 4, max: 5 },
                    ],
                );
            }
            const exact = {
                ...base,
                [field]: [{ type: "Affinities", min_value: 4, max_value: 4 }],
            };
            assert.deepEqual(parseOpenSeaBiddingOffer(exact)?.bidScope.traits, [
                { type: "Affinities", value: "4" },
            ]);
        }
    });

    it("rejects malformed stream numeric constraints without broadening the offer", () => {
        for (const field of [
            "numeric_trait_criteria_list",
            "numericTraitCriteriaList",
        ]) {
            for (const ranges of [
                {},
                [null],
                [{}],
                [{ trait_type: "Affinities", min_value: 4 }],
                [{ trait_type: "Affinities", max_value: 5 }],
                [{ trait_type: "Affinities", min_value: 5, max_value: 4 }],
                [{ trait_type: "Affinities", min_value: null, max_value: 5 }],
                [{ trait_type: "Affinities", min_value: "4", max_value: 5 }],
                [{ trait_type: "Affinities", min_value: NaN, max_value: 5 }],
                [
                    {
                        trait_type: "Affinities",
                        min_value: 4,
                        max_value: Infinity,
                    },
                ],
                [
                    {
                        trait_type: "Affinities",
                        min_value: 4,
                        max_value: 5,
                        value: "4",
                    },
                ],
                [
                    {
                        trait_type: "Affinities",
                        min: 3,
                        min_value: 4,
                        max_value: 5,
                    },
                ],
                [
                    {
                        trait_type: "Affinities",
                        min_value: 4,
                        max_value: 5,
                        maxValue: 6,
                    },
                ],
            ]) {
                const raw = {
                    ...capturedOpenSeaNumericStreamOffer.event.payload,
                    numeric_trait_criteria_list: undefined,
                    criteria: {},
                    [field]: ranges,
                };
                assert.throws(() => parseOpenSeaBiddingOffer(raw));
                assert.throws(() => isOpenSeaCollectionWideOffer(raw));
            }
        }
    });

    it("preserves strict trait-name aliases in singular and plural stream envelopes", () => {
        for (const [field, criterion] of [
            ["trait_criteria", { trait_type: "Mode", trait_name: "Terrain" }],
            ["traitCriteria", { traitType: "Mode", traitName: "Terrain" }],
            [
                "trait_criteria_list",
                [{ trait_type: "Mode", trait_name: "Terrain" }],
            ],
            [
                "traitCriteriaList",
                [{ traitType: "Mode", traitName: "Terrain" }],
            ],
        ] as const) {
            const raw = {
                ...makeSnapshotOffer({
                    orderHash: "stream-alias",
                    maker: MAKER_ADDRESS,
                    priceWei: "300000000000000000",
                    criteria: undefined,
                }),
                [field]: criterion,
            };
            assert.deepEqual(parseOpenSeaBiddingOffer(raw)?.bidScope.traits, [
                { type: "Mode", value: "Terrain" },
            ]);
        }
        for (const traitName of [{ unexpected: 1 }, ["Terrain"], null])
            assert.throws(() =>
                normalizeOpenSeaOfferTraitCriteria({
                    traitType: "Mode",
                    traitName,
                }),
            );
    });

    it("rejects conflicting numeric representations and non-scalar value aliases", () => {
        for (const numericKey of ["numeric_traits", "numericTraits"]) {
            for (const valueKey of ["value", "trait_value", "traitValue"]) {
                assert.deepEqual(
                    normalizeOpenSeaOfferTraitCriteria({
                        [numericKey]: [
                            {
                                type: "Level",
                                min: 1,
                                max: 2,
                                [valueKey]: undefined,
                            },
                        ],
                    }),
                    [{ type: "Level", min: 1, max: 2 }],
                );
                for (const value of ["10", 10, { unexpected: 1 }, [10], null])
                    assert.throws(() =>
                        parseOpenSeaBiddingOffer(
                            makeSnapshotOffer({
                                orderHash: "mixed-numeric",
                                maker: MAKER_ADDRESS,
                                priceWei: "300000000000000000",
                                criteria: {
                                    [numericKey]: [
                                        {
                                            type: "Level",
                                            min: 1,
                                            max: 2,
                                            [valueKey]: value,
                                        },
                                    ],
                                },
                            }),
                        ),
                    );
                for (const value of [{ unexpected: 1 }, [10], null, true])
                    assert.throws(() =>
                        normalizeOpenSeaOfferTraitCriteria({
                            [numericKey]: [
                                { type: "Level", [valueKey]: value },
                            ],
                        }),
                    );
                for (const value of ["10", 10])
                    assert.deepEqual(
                        normalizeOpenSeaOfferTraitCriteria({
                            [numericKey]: [
                                { type: "Level", [valueKey]: value },
                            ],
                        }),
                        [{ type: "Level", value: "10" }],
                    );
            }
            assert.throws(() =>
                normalizeOpenSeaOfferTraitCriteria({
                    [numericKey]: [
                        { type: "Level", value: "10", traitValue: [10] },
                    ],
                }),
            );
            assert.throws(() =>
                normalizeOpenSeaOfferTraitCriteria({
                    [numericKey]: [
                        { type: "Level", value: "10", traitValue: "11" },
                    ],
                }),
            );
        }
    });

    it("preserves the complete criteria and finite membership of captured ranged orders", () => {
        for (const {
            payload,
            expected,
        } of capturedOpenSeaRangedOfferFixtures) {
            const parsed = parseOpenSeaBiddingOffer(payload);
            assert.ok(parsed);
            assert.equal(parsed.id, payload.order_hash);
            assert.equal(parsed.price.toString(), expected.unitPriceWei);
            assert.equal(parsed.quantity.toString(), expected.quantity);
            assert.equal(
                parsed.maker,
                payload.protocol_data.parameters.offerer,
            );
            assert.equal(
                parsed.collectionAddress,
                payload.criteria.contract.address,
            );
            assert.equal(
                parsed.bidScope.kind,
                TRADING_BIDDING_BID_SCOPE_KIND.Trait,
            );
            assert.equal(parsed.bidScope.label, expected.label);
            assert.deepEqual(parsed.bidScope.traits, expected.traits);
            assert.equal(
                parsed.bidScope.encodedTokenIds,
                payload.criteria.encoded_token_ids,
            );
            assert.equal(isOpenSeaCollectionWideOffer(payload), false);
            assert.equal(
                openSeaEncodedTokenIdsContain(
                    payload.criteria.encoded_token_ids,
                    "132",
                ),
                false,
            );
            const members = payload.criteria.encoded_token_ids
                .split(",")
                .flatMap((segment) => {
                    const [start, end = start] = segment.split(":").map(Number);
                    return Array.from({ length: end - start + 1 }, (_, index) =>
                        String(start + index),
                    );
                });
            assert.equal(members.length, expected.encodedMembershipCount);
            for (const tokenId of members)
                assert.equal(
                    openSeaEncodedTokenIdsContain(
                        payload.criteria.encoded_token_ids,
                        tokenId,
                    ),
                    true,
                );
        }
    });

    it("rejects an entire string scope when any supplied criterion is malformed", () => {
        const mode = { type: "Mode", value: "Terrain" };
        for (const invalid of [
            null,
            "malformed",
            false,
            {},
            [],
            { traits: [] },
            { type: "Level" },
            { type: "Level", value: null },
            { type: "Level", value: { unexpected: 1 } },
            { type: "Level", value: [1, 2] },
            { type: "Level", value: NaN },
            { type: " ", value: "1" },
            { unexpected: { type: "Level", value: "1" } },
        ]) {
            const raw = makeSnapshotOffer({
                orderHash: "0xmalformed",
                maker: MAKER_ADDRESS,
                priceWei: "300000000000000000",
                criteria: undefined,
            });
            assert.throws(() =>
                parseOpenSeaBiddingOffer({
                    ...raw,
                    criteria: { traits: [mode, invalid] },
                }),
            );
            assert.throws(() =>
                parseOpenSeaBiddingOffer({
                    ...raw,
                    trait_criteria: {
                        trait_type: "Mode",
                        trait_name: "Terrain",
                    },
                    trait_criteria_list: [invalid],
                }),
            );
            if (invalid !== null)
                assert.throws(
                    () =>
                        normalizeOpenSeaOfferTraitCriteria({
                            trait: invalid,
                            numeric_traits: [{ type: "Level", min: 1, max: 2 }],
                        }),
                    "present malformed trait cannot be hidden by numeric criteria",
                );
        }
        assert.throws(() =>
            normalizeOpenSeaOfferTraitCriteria({
                traits: { Mode: "Terrain", Level: null },
            }),
        );
    });

    it("preserves supported exact aliases and all simultaneously supplied constraints", () => {
        const mode = { type: "Mode", value: "Terrain" };
        for (const criteria of [
            mode,
            { trait_type: "Mode", trait_value: "Terrain" },
            { traitType: "Mode", traitValue: "Terrain" },
            { trait_type: "Mode", trait_name: "Terrain" },
            { Mode: "Terrain" },
        ])
            assert.deepEqual(normalizeOpenSeaOfferTraitCriteria(criteria), [
                mode,
            ]);
        const normalized = normalizeOpenSeaOfferTraitCriteria({
            trait: mode,
            traits: [{ type: "Biome", value: 81 }, mode],
            numeric_traits: [{ type: "Level", min: 1, max: 2 }],
            numericTraits: [{ type: "Chroma", min: 19, max: 20 }],
        });
        assert.deepEqual(normalized, [
            mode,
            { type: "Biome", value: "81" },
            { type: "Level", min: 1, max: 2 },
            { type: "Chroma", min: 19, max: 20 },
        ]);
        assert.deepEqual(
            normalizeOpenSeaOfferTraitCriteria({ traits: normalized }),
            normalized,
        );
        assert.deepEqual(
            normalizeOpenSeaOfferTraitCriteria({
                trait: null,
                traits: [],
                numeric_traits: null,
                encoded_token_ids: "*",
            }),
            [],
        );
    });

    it("keeps token zero distinct from a criteria wildcard in REST and SDK envelopes", () => {
        const rest = makeSnapshotOffer({
            orderHash: "0xzero",
            maker: MAKER_ADDRESS,
            priceWei: "300000000000000000",
            criteria: undefined,
            itemType: 2,
            tokenId: "0",
        });
        const { protocol_data, ...fields } = rest;
        for (const raw of [
            rest,
            { ...fields, protocolData: protocol_data },
            { ...rest, criteria: {} },
            {
                ...rest,
                criteria: { trait: { type: "Mode", value: "Terrain" } },
            },
        ]) {
            const parsed = parseOpenSeaBiddingOffer(raw);
            assert.equal(parsed?.offerScope, "item");
            assert.equal(
                parsed?.bidScope.kind,
                TRADING_BIDDING_BID_SCOPE_KIND.Token,
            );
            assert.equal(parsed?.bidScope.tokenId, "0");
            assert.equal(parsed?.bidScope.label, "#0");
            assert.equal(isOpenSeaCollectionWideOffer(raw), false);
        }
        assert.equal(
            parseOpenSeaBiddingOffer(
                makeSnapshotOffer({
                    orderHash: "0xwildcard",
                    maker: MAKER_ADDRESS,
                    priceWei: "300000000000000000",
                    criteria: undefined,
                    itemType: 4,
                    tokenId: "0",
                }),
            )?.bidScope.kind,
            TRADING_BIDDING_BID_SCOPE_KIND.Collection,
        );
    });

    it("preserves mixed and numeric-only intervals in REST and SDK offers", () => {
        for (const [min, max] of [
            [1, 2],
            [19, 20],
            [-1.5, 2.5],
        ]) {
            for (const numericKey of ["numeric_traits", "numericTraits"]) {
                const criteria = {
                    traits: [{ type: "Mode", value: "Terrain" }],
                    [numericKey]: [{ type: "Level", min, max }],
                    encoded_token_ids: "1:2,19:20",
                };
                const parsed = parseOpenSeaBiddingOffer(
                    makeSnapshotOffer({
                        orderHash: "0xrange",
                        maker: MAKER_ADDRESS,
                        priceWei: "300000000000000000",
                        criteria,
                    }),
                );
                assert.ok(parsed);
                assert.equal(parsed.offerScope, "trait");
                assert.equal(
                    parsed.bidScope.kind,
                    TRADING_BIDDING_BID_SCOPE_KIND.Trait,
                );
                assert.equal(
                    parsed.bidScope.label,
                    `Mode=Terrain + Level=${min}–${max}`,
                );
                assert.deepEqual(parsed.bidScope.traits, [
                    { type: "Mode", value: "Terrain" },
                    { type: "Level", min, max },
                ]);
                const numericOnly = makeSnapshotOffer({
                    orderHash: "0xnumeric",
                    maker: MAKER_ADDRESS,
                    priceWei: "300000000000000000",
                    criteria: { [numericKey]: [{ type: "Level", min, max }] },
                });
                assert.equal(isOpenSeaCollectionWideOffer(numericOnly), false);
                assert.equal(
                    parseOpenSeaBiddingOffer(numericOnly)?.bidScope.kind,
                    TRADING_BIDDING_BID_SCOPE_KIND.Trait,
                );
            }
        }
    });

    it("rejects incomplete, reversed and non-finite numeric constraints as a whole", () => {
        for (const range of [
            { min: 1 },
            { max: 2 },
            { min: 2, max: 1 },
            { min: NaN, max: 2 },
            { min: 1, max: Infinity },
            { min: "1", max: 2 },
        ]) {
            assert.throws(() =>
                normalizeOpenSeaOfferTraitCriteria({
                    traits: [{ type: "Mode", value: "Terrain" }],
                    numeric_traits: [{ type: "Level", ...range }],
                }),
            );
        }
    });

    it("checks complete finite encoded membership without accepting malformed ranges", () => {
        assert.equal(openSeaEncodedTokenIdsContain("1:2,19:20", "1"), true);
        assert.equal(openSeaEncodedTokenIdsContain("1:2,19:20", "20"), true);
        assert.equal(openSeaEncodedTokenIdsContain("1:2,19:20", "10"), false);
        for (const invalid of ["1,broken", "2:1", "1:2:3", "1,", ""]) {
            assert.equal(openSeaEncodedTokenIdsContain(invalid, "1"), false);
        }
    });

    it("preserves direct lookup parsing from the bidder service specs", () => {
        const parsed = parseOpenSeaBiddingOffer(
            {
                order_hash: "0xhash",
                protocol_data: {
                    parameters: {
                        offerer: MAKER_ADDRESS,
                        offer: [
                            {
                                itemType: SEAPORT_ITEM_TYPE.Erc20,
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
        assert.equal(
            parsed.bidScope.kind,
            TRADING_BIDDING_BID_SCOPE_KIND.Token,
        );
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

    it("parses SDK v10 offer price payloads when protocol token sums are absent", () => {
        const parsed = parseOpenSeaBiddingOffer(
            {
                order_hash: "0xprice-only",
                maker: MAKER_ADDRESS,
                protocol_address: PROTOCOL_ADDRESS,
                protocol_data: {
                    parameters: {
                        offerer: MAKER_ADDRESS,
                        consideration: [
                            {
                                token: COLLECTION_ADDRESS,
                                identifierOrCriteria: "123",
                                amount: "1",
                                itemType: 2,
                            },
                        ],
                        endTime: "1780000000",
                    },
                },
                price: {
                    value: "1200000000000000000",
                    decimals: 18,
                    currency: "WETH",
                },
                status: "ACTIVE",
            },
            {
                collectionAddress: COLLECTION_ADDRESS,
                wethAddress: WETH_ADDRESS,
                discoverySource: "itemOffers",
            },
        );

        assert.ok(parsed);
        assert.equal(parsed.id, "0xprice-only");
        assert.equal(parsed.price, 1200000000000000000n);
        assert.equal(parsed.priceSource, "price.value");
        assert.equal(parsed.expirationTime, 1780000000);
        assert.equal(
            parsed.bidScope.kind,
            TRADING_BIDDING_BID_SCOPE_KIND.Token,
        );
        assert.equal(parsed.bidScope.tokenId, "123");
    });

    it("trims oversized trait text before creating stored bid-book labels", () => {
        const longValue = `${"x".repeat(TRADING_TRAIT_TEXT_MAX_LENGTH)}x`;
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
        assert.equal(
            parsed.bidScope.traits[0]?.value?.length,
            TRADING_TRAIT_TEXT_MAX_LENGTH,
        );
        assert.equal(parsed.bidScope.traits[0]?.value?.endsWith("..."), true);
        assert.equal(
            parsed.bidScope.label.length,
            "Dynamic=".length + TRADING_TRAIT_TEXT_MAX_LENGTH,
        );
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
        assert.equal(
            parsed.bidScope.kind,
            TRADING_BIDDING_BID_SCOPE_KIND.Collection,
        );
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
        assert.equal(
            parsed.bidScope.kind,
            TRADING_BIDDING_BID_SCOPE_KIND.Trait,
        );
        assert.equal(parsed.bidScope.label, "Zone=8");
        assert.deepEqual(parsed.bidScope.traits, [
            { type: "Zone", value: "8" },
        ]);
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
        assert.equal(
            parsed.bidScope.kind,
            TRADING_BIDDING_BID_SCOPE_KIND.Trait,
        );
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
        assert.equal(
            parsed.bidScope.kind,
            TRADING_BIDDING_BID_SCOPE_KIND.Trait,
        );
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
        assert.equal(
            parsed.bidScope.kind,
            TRADING_BIDDING_BID_SCOPE_KIND.Unknown,
        );
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
                protocol_address: "0x0000000000000068f116a894984e2db1123eb395",
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
        assert.equal(
            parsed.bidScope.kind,
            TRADING_BIDDING_BID_SCOPE_KIND.Trait,
        );
        assert.equal(parsed.bidScope.label, "Biome=42");
        assert.deepEqual(parsed.bidScope.traits, [
            { type: "Biome", value: "42" },
        ]);
        assert.equal(parsed.bidScope.encodedTokenIds, "30,314,5108:5109");
    });

    it("parses SDK v11 camelized numeric criteria offers", () => {
        const parsed = parseOpenSeaBiddingOffer(
            {
                orderHash: "0xcamel-numeric-trait",
                protocolAddress: "0x0000000000000068f116a894984e2db1123eb395",
                remainingQuantity: 2,
                protocolData: {
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
                    numericTraits: [{ traitType: "Biome", min: 42, max: 42 }],
                    encodedTokenIds: "30,314,5108:5109",
                },
            },
            {
                collectionAddress: COLLECTION_ADDRESS,
                wethAddress: WETH_ADDRESS,
            },
        );

        assert.ok(parsed);
        assert.equal(parsed.id, "0xcamel-numeric-trait");
        assert.equal(parsed.offerScope, "trait");
        assert.equal(parsed.price, 310000000000000000n);
        assert.equal(
            parsed.bidScope.kind,
            TRADING_BIDDING_BID_SCOPE_KIND.Trait,
        );
        assert.deepEqual(parsed.bidScope.traits, [
            { type: "Biome", value: "42" },
        ]);
        assert.equal(parsed.bidScope.encodedTokenIds, "30,314,5108:5109");
    });
});
