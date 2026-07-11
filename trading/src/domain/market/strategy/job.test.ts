import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import {
    BIDDER_TARGET_TYPE,
    bidderTargetRequiresOpenSeaSignedZoneTrust,
} from "./job.js";

describe("bidder target policy", () => {
    it("requires SignedZone trust only for trait-scoped targets", () => {
        assert.equal(
            bidderTargetRequiresOpenSeaSignedZoneTrust({
                type: BIDDER_TARGET_TYPE.Token,
                tokenId: "1",
            }),
            false,
        );
        assert.equal(
            bidderTargetRequiresOpenSeaSignedZoneTrust({
                type: BIDDER_TARGET_TYPE.Collection,
                quantity: 1,
            }),
            false,
        );
        assert.equal(
            bidderTargetRequiresOpenSeaSignedZoneTrust({
                type: BIDDER_TARGET_TYPE.Collection,
                quantity: 1,
                traits: [{ type: "Mode", value: "Terrain" }],
            }),
            true,
        );
        assert.equal(
            bidderTargetRequiresOpenSeaSignedZoneTrust({
                type: BIDDER_TARGET_TYPE.CompetitiveTrait,
                quantity: 1,
                targetTrait: { type: "Mode", value: "Terrain" },
                competitorTraits: [],
            }),
            true,
        );
    });
});
