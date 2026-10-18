import { describe, expect, it } from "vitest";
import { capturedOpenSeaPartialCollectionOffer as captured } from "../testing/opensea-offers.js";
import { parseOpenSeaBiddingOffer } from "./open-sea-bidding-offers.js";

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
