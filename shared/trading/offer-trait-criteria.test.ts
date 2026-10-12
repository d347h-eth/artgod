import { COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE as JOIN } from "../types/trading.js";
import { describe, expect, it } from "vitest";
import {
    biddingTraitsMatchToken,
    biddingTraitCriteriaKey,
    dedupeBiddingTraitCriteria,
    parseBiddingTraitCriteria,
    biddingTraitScopeMatchesFilters,
} from "./offer-trait-criteria.js";

const mode = { type: "Mode", value: "Terrain" };
const level = { type: "Level", min: 1, max: 2 };
describe("observed offer trait criteria", () => {
    it("deduplicates complete criteria without delimiter collisions or losing numeric bounds", () => {
        const first = { type: "A|B", value: "C" };
        const second = { type: "A", value: "B|C" };
        expect(dedupeBiddingTraitCriteria([first, second, first])).toEqual([
            first,
            second,
        ]);
        const otherLevel = { type: "Level", min: 19, max: 20 };
        expect(
            dedupeBiddingTraitCriteria([mode, level, mode, otherLevel, level]),
        ).toEqual([mode, level, otherLevel]);
    });
    it("filters whole scopes in AND mode and accepts inclusive integer intersections", () => {
        expect(
            biddingTraitScopeMatchesFilters(
                [mode, level],
                [{ key: "Mode", value: "Terrain" }],
                [],
                JOIN.And,
            ),
        ).toBe(false);
        expect(
            biddingTraitScopeMatchesFilters(
                [mode, level],
                [{ key: "Mode", value: "Terrain" }],
                [],
                JOIN.Or,
            ),
        ).toBe(true);
        for (const fromValue of ["0", "1", "2"]) {
            expect(
                biddingTraitScopeMatchesFilters(
                    [mode, level],
                    [{ key: "Mode", value: "Terrain" }],
                    [{ key: "Level", fromValue, toValue: "2" }],
                    JOIN.And,
                ),
            ).toBe(true);
        }
        expect(
            biddingTraitScopeMatchesFilters(
                [mode, level],
                [{ key: "Mode", value: "Terrain" }],
                [{ key: "Level", fromValue: "10", toValue: "20" }],
                JOIN.And,
            ),
        ).toBe(false);
        expect(
            biddingTraitScopeMatchesFilters(
                [{ type: "Level", min: 0.1, max: 0.9 }],
                [],
                [{ key: "Level", fromValue: "0", toValue: "1" }],
                JOIN.Or,
            ),
        ).toBe(false);
    });
    it("requires all criteria and inclusive decimal bounds", () => {
        for (const value of ["1", "1.5", "2", "1e0"]) {
            expect(
                biddingTraitsMatchToken(
                    [mode, level],
                    [mode, { type: "Level", value }],
                ),
            ).toBe(true);
        }
        for (const value of [
            "",
            " ",
            "0x1",
            "NaN",
            "Infinity",
            "0.9",
            "2.1",
            "10",
        ]) {
            expect(
                biddingTraitsMatchToken(
                    [mode, level],
                    [mode, { type: "Level", value }],
                ),
            ).toBe(false);
        }
        expect(biddingTraitsMatchToken([mode, level], [mode])).toBe(false);
        expect(
            biddingTraitsMatchToken(
                [mode, level],
                [
                    { type: "Mode", value: "Water" },
                    { type: "Level", value: "1" },
                ],
            ),
        ).toBe(false);
        expect(
            biddingTraitsMatchToken(
                [{ type: "Level", min: -1.5, max: -0.5 }],
                [{ type: "Level", value: "-1" }],
            ),
        ).toBe(true);
    });
    it("keeps exact scopes and different intervals distinct independent of order", () => {
        const key = biddingTraitCriteriaKey([mode, level]);
        expect(key).toBe(biddingTraitCriteriaKey([level, mode]));
        expect(key).not.toBe(biddingTraitCriteriaKey([mode]));
        expect(key).not.toBe(
            biddingTraitCriteriaKey([
                mode,
                { type: "Level", min: 19, max: 20 },
            ]),
        );
        expect(key).not.toBe(
            biddingTraitCriteriaKey([mode, { type: "Level", value: "1" }]),
        );
    });
    it("validates the whole persisted scope rather than dropping invalid constraints", () => {
        expect(parseBiddingTraitCriteria([mode, level])).toEqual([mode, level]);
        expect(() =>
            parseBiddingTraitCriteria([mode, { type: "Level", min: 1 }]),
        ).toThrow();
        expect(() =>
            parseBiddingTraitCriteria([
                mode,
                { type: "Level", value: "1", min: 1, max: 2 },
            ]),
        ).toThrow();
    });
});
