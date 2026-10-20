import { describe, expect, it } from "vitest";
import { capturedOpenSeaPartialCollectionOffer as captured } from "../testing/opensea-offers.js";
import {
    parseOpenSeaBiddingOffer,
    extractOpenSeaWethUnitPrice,
} from "./open-sea-bidding-offers.js";
import {
    SEAPORT_ITEM_TYPE,
    SEAPORT_ORDER_TYPE,
    SEAPORT_ORDER_TYPE_NAME,
} from "../market-data/seaport.js";

/** Deliberately malformed wire fields exercise the external parsing boundary. */
function priceFixture(): {
    remaining_quantity?: unknown;
    protocol_data: {
        parameters: {
            orderType?: unknown;
            offer: Array<{ startAmount: unknown; endAmount: unknown }>;
            consideration: Array<{
                token?: string;
                itemType: unknown;
                startAmount: unknown;
                endAmount: unknown;
            }>;
        };
    };
} {
    return structuredClone(captured);
}

describe("OpenSea partial offer quantity", () => {
    it.each([1, 45, 100])(
        "preserves signed price and original units with %s remaining",
        (remaining) => {
            const parsed = parseOpenSeaBiddingOffer({
                ...captured,
                remaining_quantity: remaining,
            });
            expect(parsed).toMatchObject({
                price: 60_000_000_000_000_000n,
                originalQuantity: 100n,
                quantity: BigInt(remaining),
            });
        },
    );
    it.each([0, -1, 101, "1.5", "invalid"])(
        "rejects exhausted or impossible source remainder %s",
        (remaining) => {
            expect(
                parseOpenSeaBiddingOffer({
                    ...captured,
                    remaining_quantity: remaining,
                }),
            ).toBeNull();
        },
    );
    it("uses signed units when a stream has no remainder and accepts the camel-case alias", () => {
        const { remaining_quantity: _, ...stream } = captured;
        expect(parseOpenSeaBiddingOffer(stream)).toMatchObject({
            quantity: 100n,
            originalQuantity: 100n,
        });
        expect(
            parseOpenSeaBiddingOffer({ ...stream, remainingQuantity: "45" }),
        ).toMatchObject({ quantity: 45n });
    });

    it.each([
        SEAPORT_ORDER_TYPE.PartialOpen,
        SEAPORT_ORDER_TYPE.PartialRestricted,
        String(SEAPORT_ORDER_TYPE.PartialOpen),
        SEAPORT_ORDER_TYPE_NAME.PartialOpen,
        SEAPORT_ORDER_TYPE_NAME.PartialRestricted,
        BigInt(SEAPORT_ORDER_TYPE.PartialOpen),
    ])("keeps the signed unit price for supported partial type %s", (type) => {
        const raw = priceFixture();
        delete raw.remaining_quantity;
        raw.protocol_data.parameters.orderType = type;
        expect(parseOpenSeaBiddingOffer(raw)).toMatchObject({
            price: 60_000_000_000_000_000n,
            originalQuantity: 100n,
            quantity: 100n,
        });
    });

    it.each(["ARBITRARY_PARTIAL_NAME", "PARTIAL", -1, 1.5])(
        "rejects an unknown signed order type instead of using an aggregate price (%s)",
        (type) => {
            const raw = priceFixture();
            delete raw.remaining_quantity;
            raw.protocol_data.parameters.orderType = type;
            expect(extractOpenSeaWethUnitPrice(raw)).toBeNull();
        },
    );

    it.each([undefined, "1", "45"])(
        "rejects an incomplete NFT address without falling back to a unit price (%s remaining)",
        (remaining) => {
            const raw = priceFixture();
            raw.remaining_quantity = remaining;
            delete raw.protocol_data.parameters.consideration[0].token;
            for (const collectionAddress of [
                undefined,
                captured.protocol_data.parameters.consideration[0].token,
            ])
                expect(
                    extractOpenSeaWethUnitPrice(raw, { collectionAddress }),
                ).toBeNull();
        },
    );

    it.each(["-1", "invalid", true, "", "0"])(
        "rejects an unreadable NFT count instead of pricing the rest (%s)",
        (amount) => {
            const raw = priceFixture();
            delete raw.remaining_quantity;
            raw.protocol_data.parameters.consideration[0].startAmount = amount;
            expect(extractOpenSeaWethUnitPrice(raw)).toBeNull();
        },
    );

    it.each(["-1", "invalid", true, ""])(
        "rejects an unreadable payment instead of dropping it from price (%s)",
        (amount) => {
            const raw = priceFixture();
            raw.protocol_data.parameters.offer[0].startAmount = amount;
            expect(extractOpenSeaWethUnitPrice(raw)).toBeNull();
        },
    );

    it.each([false, true])(
        "does not price a multi-unit order from a thin total or fee when its payment is missing (fee retained=%s)",
        (retainFee) => {
            const raw = priceFixture();
            delete raw.remaining_quantity;
            raw.protocol_data.parameters.offer = [];
            if (!retainFee)
                raw.protocol_data.parameters.consideration = [
                    raw.protocol_data.parameters.consideration[0],
                ];
            expect(extractOpenSeaWethUnitPrice(raw)).toBeNull();
        },
    );

    it("preserves full-only single-unit protocol pricing", () => {
        const raw = priceFixture();
        raw.protocol_data.parameters.orderType = SEAPORT_ORDER_TYPE.FullOpen;
        raw.protocol_data.parameters.consideration[0].itemType =
            SEAPORT_ITEM_TYPE.Erc721;
        raw.protocol_data.parameters.consideration[0].startAmount = "1";
        raw.protocol_data.parameters.consideration[0].endAmount = "1";
        raw.remaining_quantity = "1";
        expect(parseOpenSeaBiddingOffer(raw)).toMatchObject({
            price: 6_000_000_000_000_000_000n,
            originalQuantity: 1n,
            quantity: 1n,
        });
    });

    it.each([
        SEAPORT_ORDER_TYPE.FullOpen,
        SEAPORT_ORDER_TYPE.FullRestricted,
        SEAPORT_ORDER_TYPE_NAME.FullOpen,
        SEAPORT_ORDER_TYPE_NAME.FullRestricted,
    ])(
        "prices full-only multi-unit type %s independently of source remainder",
        (type) => {
            const raw = priceFixture();
            delete raw.remaining_quantity;
            raw.protocol_data.parameters.orderType = type;
            raw.protocol_data.parameters.consideration[0].itemType =
                SEAPORT_ITEM_TYPE.Erc1155;
            const withoutRemainder = parseOpenSeaBiddingOffer(raw);
            const withRemainder = parseOpenSeaBiddingOffer({
                ...raw,
                remaining_quantity: 100,
            });
            for (const parsed of [withoutRemainder, withRemainder]) {
                expect(parsed).toMatchObject({
                    price: 60_000_000_000_000_000n,
                    originalQuantity: 100n,
                    quantity: 100n,
                });
            }
            expect(withRemainder?.id).toBe(withoutRemainder?.id);
        },
    );

    it("rounds full-only competitor unit prices up to a whole wei", () => {
        const raw = priceFixture();
        delete raw.remaining_quantity;
        raw.protocol_data.parameters.orderType = SEAPORT_ORDER_TYPE.FullOpen;
        raw.protocol_data.parameters.consideration[0].itemType =
            SEAPORT_ITEM_TYPE.Erc1155;
        raw.protocol_data.parameters.offer[0].startAmount = "101";
        raw.protocol_data.parameters.offer[0].endAmount = "101";
        // Remove the unrelated captured fee so only the intended payment is priced.
        raw.protocol_data.parameters.consideration = [
            raw.protocol_data.parameters.consideration[0],
        ];
        expect(extractOpenSeaWethUnitPrice(raw)).toMatchObject({
            price: 2n,
            originalQuantity: 100n,
            quantity: 100n,
        });
    });

    describe.each(["price.value", "currentPrice"])(
        "thin %s records",
        (pricePath) => {
            function thin(remaining: unknown, alias = "remaining_quantity") {
                const { protocol_data: _, price, ...record } = captured;
                return {
                    ...record,
                    maker: captured.protocol_data.parameters.offerer,
                    ...(pricePath === "price.value"
                        ? { price }
                        : {
                              currentPrice: price.value,
                              paymentToken:
                                  captured.protocol_data.parameters.offer[0]
                                      .token,
                          }),
                    [alias]: remaining,
                };
            }
            it.each([0, -1, "-1", "invalid", "1.5", 2])(
                "rejects unsupported remainder %s on both aliases",
                (remaining) => {
                    for (const alias of [
                        "remaining_quantity",
                        "remainingQuantity",
                    ]) {
                        expect(
                            parseOpenSeaBiddingOffer(thin(remaining, alias)),
                        ).toBeNull();
                    }
                },
            );
            it("retains supported single-unit prices without inventing signed size", () => {
                expect(parseOpenSeaBiddingOffer(thin(1))).toMatchObject({
                    quantity: 1n,
                    originalQuantity: null,
                    price: BigInt(captured.price.value),
                });
                const record = thin(1);
                delete (record as Record<string, unknown>).remaining_quantity;
                expect(parseOpenSeaBiddingOffer(record)).toMatchObject({
                    quantity: 1n,
                    originalQuantity: null,
                });
            });
        },
    );
});
