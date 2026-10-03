import { describe, expect, it } from "vitest";
import { parseEther } from "viem";
import {
    TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND as Ceiling,
    TRADING_BIDDING_PRICE_TIER_DELTA_KIND as Delta,
    TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND as Floor,
} from "../types/trading.js";
import {
    resolveBiddingPriceTierCeilingWei,
    resolveBiddingPriceTierFloorWei,
} from "./bidding-price-tier-pricing.js";

describe("bidding price tier calculations", () => {
    it("resolves fixed prices independently of a parent", () => {
        expect(
            resolveBiddingPriceTierFloorWei({
                kind: Floor.Fixed,
                valueEth: "1.3",
            }),
        ).toBe(parseEther("1.3"));
        expect(
            resolveBiddingPriceTierCeilingWei(
                { kind: Ceiling.Fixed, valueEth: "1.4" },
                0n,
            ),
        ).toBe(parseEther("1.4"));
    });

    it("applies signed absolute offsets to each parent endpoint", () => {
        expect(
            resolveBiddingPriceTierFloorWei(
                {
                    kind: Floor.ParentDelta,
                    deltaKind: Delta.Absolute,
                    deltaEth: "+0.1",
                },
                parseEther("1.2"),
            ),
        ).toBe(parseEther("1.3"));
        expect(
            resolveBiddingPriceTierCeilingWei(
                {
                    kind: Ceiling.ParentDelta,
                    deltaKind: Delta.Absolute,
                    deltaEth: "-0.2",
                },
                0n,
                parseEther("1.6"),
            ),
        ).toBe(parseEther("1.4"));
    });

    it("uses the resolved floor for absolute and percent ceiling offsets", () => {
        expect(
            resolveBiddingPriceTierCeilingWei(
                {
                    kind: Ceiling.FloorDelta,
                    deltaKind: Delta.Absolute,
                    deltaEth: "0.1",
                },
                parseEther("1.3"),
            ),
        ).toBe(parseEther("1.4"));
        expect(
            resolveBiddingPriceTierCeilingWei(
                {
                    kind: Ceiling.FloorDelta,
                    deltaKind: Delta.Percent,
                    percent: "25",
                },
                parseEther("0.8"),
            ),
        ).toBe(parseEther("1"));
    });

    it("retains six percent decimals and truncates fractional wei toward zero", () => {
        expect(
            resolveBiddingPriceTierFloorWei(
                {
                    kind: Floor.ParentDelta,
                    deltaKind: Delta.Percent,
                    percent: "+12.3456789",
                },
                parseEther("1"),
            ),
        ).toBe(parseEther("1.12345678"));
        expect(
            resolveBiddingPriceTierFloorWei(
                {
                    kind: Floor.ParentDelta,
                    deltaKind: Delta.Percent,
                    percent: "-12.3456789",
                },
                parseEther("1"),
            ),
        ).toBe(parseEther("0.87654322"));
        expect(
            resolveBiddingPriceTierCeilingWei(
                {
                    kind: Ceiling.FloorDelta,
                    deltaKind: Delta.Percent,
                    percent: "10",
                },
                19n,
            ),
        ).toBe(20n);
        expect(
            resolveBiddingPriceTierCeilingWei(
                {
                    kind: Ceiling.FloorDelta,
                    deltaKind: Delta.Percent,
                    percent: "-10",
                },
                19n,
            ),
        ).toBe(18n);
    });

    it("requires the relevant parent endpoint", () => {
        expect(() =>
            resolveBiddingPriceTierFloorWei({
                kind: Floor.ParentDelta,
                deltaKind: Delta.Absolute,
                deltaEth: "0",
            }),
        ).toThrow("floorConfig requires a parent tier");
        expect(() =>
            resolveBiddingPriceTierCeilingWei(
                {
                    kind: Ceiling.ParentDelta,
                    deltaKind: Delta.Percent,
                    percent: "1",
                },
                1n,
            ),
        ).toThrow("ceilingConfig requires a parent tier");
    });

    it.each(["", "0", "-1", "nope", "+"])(
        "rejects invalid fixed prices: %s",
        (valueEth) => {
            expect(() =>
                resolveBiddingPriceTierFloorWei({
                    kind: Floor.Fixed,
                    valueEth,
                }),
            ).toThrow(RangeError);
        },
    );

    it.each(["", "nope", "+"])(
        "rejects invalid absolute offsets: %s",
        (deltaEth) => {
            expect(() =>
                resolveBiddingPriceTierFloorWei(
                    {
                        kind: Floor.ParentDelta,
                        deltaKind: Delta.Absolute,
                        deltaEth,
                    },
                    1n,
                ),
            ).toThrow(RangeError);
        },
    );

    it.each(["", "nope", "1e2", "+"])(
        "rejects invalid percent offsets: %s",
        (percent) => {
            expect(() =>
                resolveBiddingPriceTierFloorWei(
                    {
                        kind: Floor.ParentDelta,
                        deltaKind: Delta.Percent,
                        percent,
                    },
                    1n,
                ),
            ).toThrow(RangeError);
        },
    );

    it("rejects offsets resolving to a non-positive price", () => {
        expect(() =>
            resolveBiddingPriceTierFloorWei(
                {
                    kind: Floor.ParentDelta,
                    deltaKind: Delta.Absolute,
                    deltaEth: "-1",
                },
                parseEther("1"),
            ),
        ).toThrow("floorConfig resolves to a non-positive price");
        expect(() =>
            resolveBiddingPriceTierCeilingWei(
                {
                    kind: Ceiling.FloorDelta,
                    deltaKind: Delta.Percent,
                    percent: "-100",
                },
                1n,
            ),
        ).toThrow("ceilingConfig resolves to a non-positive price");
    });
});
