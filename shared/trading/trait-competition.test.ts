import { describe, expect, it } from "vitest";
import {
    MAX_EXTRA_COMPETITION_TRAITS,
    normalizeExtraCompetitionTraits,
    TraitCompetitionValidationError,
    normalizeTraitBiddingTarget,
    competitionPresetMatchesTarget,
    assertCompetitionPresetSelection,
    normalizeCompetitionPresetTarget,
    competitionTraitsLabel,
    MAX_COMPETITION_PRESET_TARGET_TRAITS,
    assertCompetitionPresetSourceUnchanged,
} from "./trait-competition.js";

describe("extra competition selectors", () => {
    it("preserves source identity across selector ordering and whitespace", () => {
        expect(() =>
            assertCompetitionPresetSourceUnchanged(
                [{ type: "Mode", value: "Terrain" }, { type: "Zone" }],
                [{ type: " Zone " }, { type: " Mode ", value: " Terrain " }],
            ),
        ).not.toThrow();
    });
    it("rejects changing source keys, values, wildcard choices or key count", () => {
        const source = [{ type: "Mode", value: "Terrain" }, { type: "Zone" }];
        for (const changed of [
            [{ type: "Biome", value: "Terrain" }, { type: "Zone" }],
            [{ type: "Mode", value: "Daydream" }, { type: "Zone" }],
            [{ type: "Mode" }, { type: "Zone" }],
            [
                { type: "Mode", value: "Terrain" },
                { type: "Zone", value: "Kairo" },
            ],
            [{ type: "Mode", value: "Terrain" }],
        ])
            expect(() =>
                assertCompetitionPresetSourceUnchanged(source, changed),
            ).toThrow(TraitCompetitionValidationError);
        // A literal metadata value named any never stands in for a wildcard.
        for (const [saved, proposed] of [
            [[{ type: "Zone" }], [{ type: "Zone", value: "any" }]],
            [[{ type: "Zone", value: "any" }], [{ type: "Zone" }]],
        ])
            expect(() =>
                assertCompetitionPresetSourceUnchanged(saved, proposed),
            ).toThrow(TraitCompetitionValidationError);
    });
    it("applies source wildcards only to the same complete target key combination", () => {
        const preset = {
            targetTraits: normalizeCompetitionPresetTarget([
                { type: " Zone " },
                { type: "Mode", value: " Terrain " },
            ]),
        };
        for (const value of ["Kairo", "Elsewhere", "any", "*"]) {
            expect(
                competitionPresetMatchesTarget(preset, [
                    { type: "Zone", value },
                    { type: "Mode", value: "Terrain" },
                ]),
            ).toBe(true);
        }
        for (const target of [
            [{ type: "Zone", value: "Kairo" }],
            [
                { type: "Zone", value: "Kairo" },
                { type: "Mode", value: "Daydream" },
            ],
            [
                { type: "Zone", value: "Kairo" },
                { type: "Biome", value: "42" },
            ],
            [
                { type: "Zone", value: "Kairo" },
                { type: "Mode", value: "Terrain" },
                { type: "Biome", value: "42" },
            ],
        ])
            expect(competitionPresetMatchesTarget(preset, target)).toBe(false);
        expect(
            competitionPresetMatchesTarget(
                { targetTraits: [{ type: "Zone" }, { type: "Mode" }] },
                [
                    { type: "Mode", value: "Daydream" },
                    { type: "Zone", value: "any" },
                ],
            ),
        ).toBe(true);
    });
    it("rejects empty, oversized and repeated source keys without silently merging the source", () => {
        for (const value of [
            [],
            null,
            Array(MAX_COMPETITION_PRESET_TARGET_TRAITS + 1).fill({
                type: "Mode",
            }),
            [{ type: "Zone" }, { type: "Zone", value: "Kairo" }],
            [
                { type: "Zone", value: "Kairo" },
                { type: "Zone", value: "Elsewhere" },
            ],
            [{ type: "Zone", value: "" }],
        ])
            expect(() => normalizeCompetitionPresetTarget(value)).toThrow(
                TraitCompetitionValidationError,
            );
        // Ordinary marketplace targets continue to require concrete values.
        expect(() => normalizeTraitBiddingTarget([{ type: "Zone" }])).toThrow(
            TraitCompetitionValidationError,
        );
    });
    it("keeps literal metadata values named any separate from wildcard selections", () => {
        const preset = {
            targetTraits: normalizeCompetitionPresetTarget([
                { type: "Mode", value: "any" },
            ]),
        };
        expect(
            competitionPresetMatchesTarget(preset, [
                { type: "Mode", value: "Terrain" },
            ]),
        ).toBe(false);
        expect(
            competitionPresetMatchesTarget(preset, [
                { type: "Mode", value: "any" },
            ]),
        ).toBe(true);
        expect(competitionTraitsLabel([{ type: "Mode" }])).toBe("Mode=any");
        expect(competitionTraitsLabel(preset.targetTraits)).toBe('Mode="any"');
    });
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
