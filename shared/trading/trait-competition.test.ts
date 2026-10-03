import { describe, expect, it } from "vitest";
import {
    MAX_EXTRA_COMPETITION_TRAITS,
    normalizeExtraCompetitionTraits,
    TraitCompetitionValidationError,
    normalizeTraitBiddingTarget,
    competitionPresetMatchesTarget,
    assertCompetitionPresetSelection,
} from "./trait-competition.js";

describe("extra competition selectors", () => {
    it("compares canonical AND targets and only permits old versions when already selected", () => {
        const traits = normalizeTraitBiddingTarget([
            { type: " Zone ", value: " Kairo " },
            { type: "Mode", value: "Terrain" },
        ]);
        const preset = {
            targetTraits: [...traits].reverse(),
            revision: 1,
            currentRevision: 2,
            archivedAt: "2026-10-04",
        };
        expect(competitionPresetMatchesTarget(preset, traits)).toBe(true);
        expect(competitionPresetMatchesTarget(preset, traits.slice(1))).toBe(
            false,
        );
        expect(() =>
            assertCompetitionPresetSelection(preset, traits, true),
        ).not.toThrow();
        expect(() =>
            assertCompetitionPresetSelection(preset, traits, false),
        ).toThrow(TraitCompetitionValidationError);
        expect(() =>
            assertCompetitionPresetSelection(preset, traits.slice(1), true),
        ).toThrow(TraitCompetitionValidationError);
        expect(() =>
            normalizeTraitBiddingTarget([traits[0], traits[0]]),
        ).toThrow(TraitCompetitionValidationError);
    });
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
