import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import {
    TRADING_BOT_KIND,
    TRADING_JOB_STATUS,
    TRADING_JOB_TARGET_KIND,
    type PersistedBiddingJobRecord,
} from "@artgod/shared/types";
import {
    TradingValidationError,
    assertFloorNotAboveCeiling,
    mapPersistedBiddingJobToView,
    parsePositiveEthToWei,
} from "./types.js";

describe("trading use-case shared types", () => {
    it("parses positive Ether amounts and rejects invalid bidding prices", () => {
        assert.equal(parsePositiveEthToWei(" 0.25 ", "floorEth"), "250000000000000000");
        assert.throws(
            () => parsePositiveEthToWei(" ", "floorEth"),
            /floorEth is required/,
        );
        assert.throws(
            () => parsePositiveEthToWei("0", "floorEth"),
            /floorEth must be > 0/,
        );
        assert.throws(
            () => parsePositiveEthToWei("not-eth", "floorEth"),
            TradingValidationError,
        );
    });

    it("rejects floor prices above ceilings", () => {
        assert.doesNotThrow(() => assertFloorNotAboveCeiling("1", "1"));
        assert.throws(
            () => assertFloorNotAboveCeiling("2", "1"),
            /floorEth must be <= ceilingEth/,
        );
    });

    it("maps competitive-trait jobs and optional runtime amounts into API views", () => {
        const view = mapPersistedBiddingJobToView({
            ...baseJob(),
            targetKind: TRADING_JOB_TARGET_KIND.CompetitiveTrait,
            tokenId: null,
            quantity: 1,
            targetTraits: [{ type: "Mode", value: "Terrain" }],
            competitorTraits: [{ type: "Biome", value: "42" }],
            runtime: {
                currentPriceWei: "150000000000000000",
                activeOrderId: "order-1",
                activeProtocolAddress:
                    "0x0000000000000068f116a894984e2db1123eb395",
                activeOrderPlacedAt: "2026-05-17T00:00:00Z",
                activeOrderVerifiedAt: "2026-05-17T00:00:02Z",
                activeExpirationTimeMs: 4_000_000_000_000,
                bidPosition: null,
                bidConstraints: [],
                competitorPriceWei: null,
                lastRunAt: "2026-05-15T00:00:00Z",
                lastError: null,
                cancellationRequestedAt: null,
                cancellationCompletedAt: null,
                cancellationError: null,
                updatedAt: "2026-05-15T00:00:00Z",
            },
        });

        assert.deepEqual(view.target, {
            type: "competitiveTrait",
            quantity: 1,
            targetTraits: [{ type: "Mode", value: "Terrain" }],
            competitorTraits: [{ type: "Biome", value: "42" }],
        });
        assert.equal(view.runtime?.currentPriceEth, "0.15");
        assert.equal(view.runtime?.activeOrderId, "order-1");
        assert.equal(view.runtime?.activeOrderPlacedAt, "2026-05-17T00:00:00Z");
        assert.equal(view.runtime?.activeOrderVerifiedAt, "2026-05-17T00:00:02Z");
        assert.equal(view.runtime?.bidPosition, null);
        assert.deepEqual(view.runtime?.bidConstraints, []);
        assert.equal(view.runtime?.competitorPriceEth, null);
    });
});

function baseJob(): PersistedBiddingJobRecord {
    return {
        jobId: "job-1",
        botKind: TRADING_BOT_KIND.Bidding,
        chainId: 1,
        collectionId: 7,
        collectionSlug: "terraforms",
        collectionOpenseaSlug: "terraforms",
        collectionAddress: "0x1111111111111111111111111111111111111111",
        status: TRADING_JOB_STATUS.Enabled,
        targetKind: TRADING_JOB_TARGET_KIND.Collection,
        tokenId: null,
        quantity: 1,
        targetTraits: [],
        competitorTraits: [],
        floorWei: "100000000000000000",
        ceilingWei: "200000000000000000",
        deltaWei: "1000000000000000",
        priceTierId: null,
        pricingSource: null,
        revision: 1,
        createdAt: "2026-05-15T00:00:00Z",
        updatedAt: "2026-05-15T00:00:00Z",
        archivedAt: null,
        runtime: null,
    };
}
