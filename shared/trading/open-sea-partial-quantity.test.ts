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
});
