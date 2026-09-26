import { describe, expect, it } from "vitest";
import {
    MAX_EXTRA_COMPETITION_TRAITS,
    normalizeExtraCompetitionTraits,
    TraitCompetitionValidationError,
} from "./trait-competition.js";

describe("extra competition selectors", () => {
    it("canonicalizes exact values, whole keys and duplicates without wildcard expansion", () => {
        expect(
            normalizeExtraCompetitionTraits([
                { type: " Zone ", value: " Kairo " },
                { type: "Zone", value: "Kairo" },
                { type: "Mode", value: "Terrain" },
                { type: "Mode" },
            ]),
        ).toEqual([{ type: "Mode" }, { type: "Zone", value: "Kairo" }]);
        expect(normalizeExtraCompetitionTraits([])).toEqual([]);
    });
    it("rejects malformed or oversized declarations instead of silently widening them", () => {
        for (const value of [
            null,
            {},
            "Mode",
            [{ type: "" }],
            [{ type: "Mode", value: "" }],
            [{ type: "Mode", value: null }],
            [{ type: "Mode", values: ["Terrain"] }],
            Array(MAX_EXTRA_COMPETITION_TRAITS + 1).fill({ type: "Mode" }),
        ]) {
            expect(() => normalizeExtraCompetitionTraits(value)).toThrow(
                TraitCompetitionValidationError,
            );
        }
    });
});
