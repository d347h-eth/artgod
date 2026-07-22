import { describe, expect, it } from "vitest";
import {
    resolveOpenSeaExplicitTokenBoundaryIds,
    resolveOpenSeaTokenRangeBoundaryIds,
} from "./collection-slug-probe.js";

describe("OpenSea slug verification token boundaries", () => {
    it("returns the first and last token in a continuous range", () => {
        expect(
            resolveOpenSeaTokenRangeBoundaryIds({
                startTokenId: "462000000",
                totalSupply: 400,
            }),
        ).toEqual(["462000000", "462000399"]);
    });

    it("returns one token for a singleton range", () => {
        expect(
            resolveOpenSeaTokenRangeBoundaryIds({
                startTokenId: "001",
                totalSupply: 1,
            }),
        ).toEqual(["1"]);
    });

    it("returns the numeric boundaries of an explicit token scope", () => {
        expect(
            resolveOpenSeaExplicitTokenBoundaryIds(["10", "2", "002", " 30 "]),
        ).toEqual(["2", "30"]);
    });

    it("rejects non-integer or unsafe range supplies", () => {
        expect(
            resolveOpenSeaTokenRangeBoundaryIds({
                startTokenId: "1",
                totalSupply: 1.5,
            }),
        ).toEqual([]);
        expect(
            resolveOpenSeaTokenRangeBoundaryIds({
                startTokenId: "1",
                totalSupply: Number.MAX_SAFE_INTEGER + 1,
            }),
        ).toEqual([]);
    });
});
