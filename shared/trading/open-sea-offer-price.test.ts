import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { parseEther } from "viem";
import {
    getOpenSeaBidDeltaStepWei,
    getOpenSeaOfferPriceStepWei,
    isValidOpenSeaBidDeltaWei,
    nearestOpenSeaBidDeltaWei,
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

describe("OpenSea bidding delta precision", () => {
    it.each([
        ["0", "0", "0.0001"],
        ["0.01", "0.0999", "0.0001"],
        ["0.0999", "0.1", "0.001"],
        ["0.1", "0.999", "0.001"],
        ["0.9", "1", "0.01"],
        ["1.3", "1.4", "0.01"],
        ["20", "30", "0.01"],
        ["1.3", "0.4", "0.01"],
    ])("uses a %s to %s WETH range step of %s", (floor, ceiling, step) => {
        expectStep(floor, ceiling, step);
    });

    it.each([
        ["-0.1", "0.1"],
        ["0.1", "-0.1"],
    ])("rejects negative endpoints (%s, %s)", (floor, ceiling) => {
        assert.throws(
            () =>
                getOpenSeaBidDeltaStepWei(
                    parseEther(floor),
                    parseEther(ceiling),
                ),
            /non-negative/,
        );
    });

    it.each([
        ["0", false, "0.01"],
        ["-1", false, "0.01"],
        ["0.001", false, "0.01"],
        ["0.01", true, "0.01"],
        ["0.014999999999999999", false, "0.01"],
        ["0.015", false, "0.02"],
        ["0.015000000000000001", false, "0.02"],
        ["0.019999999999999999", false, "0.02"],
        ["0.02", true, "0.02"],
        ["0.025", false, "0.03"],
        ["2", true, "2"],
    ])(
        "validates and suggests the closest delta for %s WETH",
        (delta, valid, expected) => {
            const floor = parseEther("1.3");
            const ceiling = parseEther("1.4");
            const amount = parseEther(delta);
            const nearest = nearestOpenSeaBidDeltaWei(amount, floor, ceiling);
            assert.equal(
                isValidOpenSeaBidDeltaWei(amount, floor, ceiling),
                valid,
            );
            assert.equal(nearest, parseEther(expected));
            assert.ok(isValidOpenSeaBidDeltaWei(nearest, floor, ceiling));
            assert.equal(
                nearestOpenSeaBidDeltaWei(nearest, floor, ceiling),
                nearest,
            );
        },
    );

    it.each([
        ["0.00015", "0.01", "0.09", "0.0002"],
        ["0.0044", "0.3", "0.4", "0.004"],
        ["0.0045", "0.3", "0.4", "0.005"],
        ["0.0001", "0.09", "0.1", "0.001"],
        ["0.001", "0.9", "1", "0.01"],
        ["0.01", "1.3", "1.3", "0.01"],
    ])(
        "suggests %s within %s to %s WETH as %s",
        (delta, floor, ceiling, expected) => {
            assert.equal(
                nearestOpenSeaBidDeltaWei(
                    parseEther(delta),
                    parseEther(floor),
                    parseEther(ceiling),
                ),
                parseEther(expected),
            );
        },
    );
});

function expectStep(floor: string, ceiling: string, step: string): void {
    assert.equal(
        getOpenSeaBidDeltaStepWei(parseEther(floor), parseEther(ceiling)),
        parseEther(step),
    );
    assert.equal(
        getOpenSeaOfferPriceStepWei(parseEther(ceiling)),
        getOpenSeaBidDeltaStepWei(0n, parseEther(ceiling)),
    );
}
