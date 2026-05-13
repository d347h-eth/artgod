import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import {
    TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND,
    TRADING_BIDDING_PRICE_TIER_DELTA_KIND,
    TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND,
    TRADING_JOB_STATUS,
    type PersistedBiddingPriceTierRecord,
} from "@artgod/shared/types";
import { resolveBiddingPriceTierGraph } from "./bidding-price-tiers.js";
import { TradingValidationError } from "./types.js";

const BASE_TIER: PersistedBiddingPriceTierRecord = {
    tierId: "root",
    chainId: 1,
    collectionId: 1,
    name: "Root",
    status: TRADING_JOB_STATUS.Enabled,
    sortOrder: 1,
    parentTierId: null,
    floorConfig: {
        kind: TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.Fixed,
        valueEth: "1",
    },
    ceilingConfig: {
        kind: TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.FloorDelta,
        deltaKind: TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Absolute,
        deltaEth: "0.25",
    },
    deltaWei: "1000000000000000",
    resolvedFloorWei: null,
    resolvedCeilingWei: null,
    resolvedAt: null,
    lastError: null,
    revision: 1,
    createdAt: "2026-05-12T00:00:00Z",
    updatedAt: "2026-05-12T00:00:00Z",
    archivedAt: null,
};

describe("resolveBiddingPriceTierGraph", () => {
    it("resolves fixed root prices and child percent deltas into wei", () => {
        const child: PersistedBiddingPriceTierRecord = {
            ...BASE_TIER,
            tierId: "child",
            name: "Child",
            sortOrder: 2,
            parentTierId: "root",
            floorConfig: {
                kind: TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.ParentDelta,
                deltaKind: TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Percent,
                percent: "10",
            },
            ceilingConfig: {
                kind: TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.ParentDelta,
                deltaKind: TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Percent,
                percent: "20",
            },
        };

        const resolved = resolveBiddingPriceTierGraph(
            [BASE_TIER, child],
            "2026-05-12T01:00:00Z",
        );

        assert.equal(resolved[0]?.resolvedFloorWei, "1000000000000000000");
        assert.equal(resolved[0]?.resolvedCeilingWei, "1250000000000000000");
        assert.equal(resolved[1]?.resolvedFloorWei, "1100000000000000000");
        assert.equal(resolved[1]?.resolvedCeilingWei, "1500000000000000000");
        assert.equal(resolved[1]?.resolvedAt, "2026-05-12T01:00:00Z");
    });

    it("rejects invalid Ether strings while resolving scalar output", () => {
        assert.throws(
            () =>
                resolveBiddingPriceTierGraph([
                    {
                        ...BASE_TIER,
                        floorConfig: {
                            kind: TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.Fixed,
                            valueEth: "not-ether",
                        },
                    },
                ]),
            TradingValidationError,
        );
    });

    it("rejects cyclic parent relationships", () => {
        const left: PersistedBiddingPriceTierRecord = {
            ...BASE_TIER,
            tierId: "left",
            parentTierId: "right",
            floorConfig: {
                kind: TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.ParentDelta,
                deltaKind: TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Absolute,
                deltaEth: "0.1",
            },
        };
        const right: PersistedBiddingPriceTierRecord = {
            ...BASE_TIER,
            tierId: "right",
            parentTierId: "left",
            floorConfig: {
                kind: TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.ParentDelta,
                deltaKind: TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Absolute,
                deltaEth: "0.1",
            },
        };

        assert.throws(
            () => resolveBiddingPriceTierGraph([left, right]),
            TradingValidationError,
        );
    });
});
