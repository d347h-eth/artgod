import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import {
    TRADING_BIDDING_JOB_PRICING_SOURCE_KIND,
    TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND,
    TRADING_BIDDING_PRICE_TIER_DELTA_KIND,
    TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND,
    TRADING_JOB_STATUS,
    type PersistedBiddingPriceTierRecord,
} from "@artgod/shared/types";
import { resolveBiddingJobPricing } from "./bidding-job-pricing.js";

describe("resolveBiddingJobPricing", () => {
    it("requires manual floor and ceiling prices", () => {
        assert.throws(
            () =>
                resolveBiddingJobPricing({
                    chainId: 1,
                    collectionId: 7,
                    input: {
                        ceilingEth: "0.2",
                        deltaEth: "0.001",
                    },
                    priceTierReadPort: { listCollectionPriceTiers: () => [] },
                }),
            /floorEth is required/,
        );
        assert.throws(
            () =>
                resolveBiddingJobPricing({
                    chainId: 1,
                    collectionId: 7,
                    input: {
                        floorEth: "0.1",
                        deltaEth: "0.001",
                    },
                    priceTierReadPort: { listCollectionPriceTiers: () => [] },
                }),
            /ceilingEth is required/,
        );
    });

    it("rejects missing tier-backed pricing selections", () => {
        assert.throws(
            () =>
                resolveBiddingJobPricing({
                    chainId: 1,
                    collectionId: 7,
                    input: {
                        deltaEth: "0.001",
                        priceTierId: "missing",
                    },
                    priceTierReadPort: { listCollectionPriceTiers: () => [] },
                }),
            /priceTierId was not found/,
        );
    });

    it("rejects invalid tier graphs before resolving tier-backed prices", () => {
        assert.throws(
            () =>
                resolveBiddingJobPricing({
                    chainId: 1,
                    collectionId: 7,
                    input: {
                        deltaEth: "0.001",
                        priceTierId: "child",
                    },
                    priceTierReadPort: {
                        listCollectionPriceTiers: () => [
                            priceTier({
                                tierId: "child",
                                parentTierId: "missing",
                                floorConfig: {
                                    kind: TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.ParentDelta,
                                    deltaKind:
                                        TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Absolute,
                                    deltaEth: "0.1",
                                },
                            }),
                        ],
                    },
                }),
            /references missing parent/,
        );
    });

    it("returns scalar pricing metadata for valid tier-backed selections", () => {
        const resolved = resolveBiddingJobPricing({
            chainId: 1,
            collectionId: 7,
            input: {
                deltaEth: "0.001",
                priceTierId: "base",
            },
            priceTierReadPort: {
                listCollectionPriceTiers: () => [
                    priceTier({
                        tierId: "base",
                        name: "Base",
                    }),
                ],
            },
        });

        assert.equal(resolved.floorWei, "100000000000000000");
        assert.equal(resolved.ceilingWei, "200000000000000000");
        assert.equal(resolved.deltaWei, "1000000000000000");
        assert.equal(resolved.priceTierId, "base");
        assert.equal(
            resolved.pricingSource.kind,
            TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.PriceTier,
        );
        assert.equal(resolved.pricingSource.tierName, "Base");
    });
});

function priceTier(
    overrides: Partial<PersistedBiddingPriceTierRecord> = {},
): PersistedBiddingPriceTierRecord {
    return {
        tierId: "tier",
        chainId: 1,
        collectionId: 7,
        name: "Tier",
        status: TRADING_JOB_STATUS.Enabled,
        sortOrder: 1,
        parentTierId: null,
        floorConfig: {
            kind: TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.Fixed,
            valueEth: "0.1",
        },
        ceilingConfig: {
            kind: TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.Fixed,
            valueEth: "0.2",
        },
        deltaWei: "1000000000000000",
        resolvedFloorWei: null,
        resolvedCeilingWei: null,
        resolvedAt: null,
        lastError: null,
        revision: 1,
        createdAt: "2026-05-15T00:00:00Z",
        updatedAt: "2026-05-15T00:00:00Z",
        archivedAt: null,
        ...overrides,
    };
}
