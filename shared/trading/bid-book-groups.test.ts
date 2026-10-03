import { describe, expect, it } from "vitest";
import { TRADING_BIDDING_BID_SCOPE_KIND as SCOPE } from "../types/trading.js";
import {
    biddingBidBookGroupKey,
    canonicalBiddingBidBookTraits,
    type BiddingBidBookGroupScope,
} from "./bid-book-groups.js";

const traitScope: BiddingBidBookGroupScope = {
    kind: SCOPE.Trait,
    label: "Mode=Terrain + Biome=42",
    tokenId: null,
    traits: [
        { type: "Mode", value: "Terrain" },
        { type: "Biome", value: "42" },
    ],
};

describe("bid-book group identity", () => {
    it("identifies complete trait combinations regardless of label or criterion order", () => {
        expect(
            biddingBidBookGroupKey({
                ...traitScope,
                label: "another display label",
                traits: [...traitScope.traits].reverse(),
            }),
        ).toBe(biddingBidBookGroupKey(traitScope));
        expect(
            biddingBidBookGroupKey({
                ...traitScope,
                traits: [traitScope.traits[0]],
            }),
        ).not.toBe(biddingBidBookGroupKey(traitScope));
        expect(canonicalBiddingBidBookTraits(traitScope.traits)).toEqual([
            { type: "Biome", value: "42" },
            { type: "Mode", value: "Terrain" },
        ]);
        expect(traitScope.traits[0].type).toBe("Mode");
    });

    it("preserves boundaries when marketplace trait text contains delimiters", () => {
        expect(
            biddingBidBookGroupKey({
                ...traitScope,
                traits: [{ type: "Mode", value: "Terrain\u0000extra" }],
            }),
        ).not.toBe(
            biddingBidBookGroupKey({
                ...traitScope,
                traits: [{ type: "Mode\u0000Terrain", value: "extra" }],
            }),
        );
    });

    it("identifies token groups by token ID independently of display text", () => {
        const scope = {
            ...traitScope,
            kind: SCOPE.Token,
            tokenId: "101",
        };
        expect(
            biddingBidBookGroupKey({ ...scope, label: "#101", traits: [] }),
        ).toBe(biddingBidBookGroupKey(scope));
        expect(biddingBidBookGroupKey({ ...scope, tokenId: "102" })).not.toBe(
            biddingBidBookGroupKey(scope),
        );
    });

    it("keeps unclassified scopes distinct when no target criteria exist", () => {
        const scope = { ...traitScope, traits: [], kind: SCOPE.Unknown };
        expect(
            biddingBidBookGroupKey({ ...scope, label: "other scope" }),
        ).not.toBe(biddingBidBookGroupKey(scope));
        expect(
            biddingBidBookGroupKey({ ...scope, kind: SCOPE.Collection }),
        ).not.toBe(biddingBidBookGroupKey(scope));
    });
});
