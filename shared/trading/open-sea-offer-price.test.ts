import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { parseEther } from "viem";
import {
    roundOpenSeaOfferPriceDown,
    roundOpenSeaOfferPriceUp,
} from "./open-sea-offer-price.js";

describe("OpenSea WETH offer price precision", () => {
    it.each([
        ["0", "0", "0"],
        ["0.000000000000000001", "0", "0.0001"],
        ["0.000099999999999999", "0", "0.0001"],
        ["0.0001", "0.0001", "0.0001"],
        ["0.054234567890123456", "0.0542", "0.0543"],
        ["0.0999", "0.0999", "0.0999"],
        ["0.099999999999999999", "0.0999", "0.1"],
        ["0.1", "0.1", "0.1"],
        ["0.100000000000000001", "0.1", "0.101"],
        ["0.235678901234567891", "0.235", "0.236"],
        ["0.999", "0.999", "0.999"],
        ["0.999999999999999999", "0.999", "1"],
        ["1", "1", "1"],
        ["1.000000000000000001", "1", "1.01"],
        ["1.3016563", "1.3", "1.31"],
        ["13.2002", "13.2", "13.21"],
        ["1000000000.123456789012345678", "1000000000.12", "1000000000.13"],
    ])("rounds %s WETH within the correct price tier", (input, down, up) => {
        const amountWei = parseEther(input);
        const roundedDown = roundOpenSeaOfferPriceDown(amountWei);
        const roundedUp = roundOpenSeaOfferPriceUp(amountWei);

        assert.equal(roundedDown, parseEther(down));
        assert.equal(roundedUp, parseEther(up));
        assert.ok(roundedDown <= amountWei);
        assert.ok(roundedUp >= amountWei);
        assert.equal(roundOpenSeaOfferPriceUp(roundedDown), roundedDown);
        assert.equal(roundOpenSeaOfferPriceDown(roundedUp), roundedUp);
    });

    it("rejects negative prices in both rounding directions", () => {
        assert.throws(() => roundOpenSeaOfferPriceDown(-1n), /non-negative/);
        assert.throws(() => roundOpenSeaOfferPriceUp(-1n), /non-negative/);
    });
});
