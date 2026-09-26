import { describe, expect, it } from "vitest";
import { matchesTraitCompetition } from "./trait-competition.js";

const mode = { type: "Mode", value: "Terrain" };
const zone = { type: "Zone", value: "Kairo" };
const biome = { type: "Biome", value: "91" };

describe("trait competition", () => {
    it("adds exact or whole-key standalone buckets without including multitraits", () => {
        expect(matchesTraitCompetition([mode], [zone, biome], [mode])).toBe(
            true,
        );
        expect(
            matchesTraitCompetition(
                [{ type: "Mode", value: "Water" }],
                [zone],
                [mode],
            ),
        ).toBe(false);
        expect(
            matchesTraitCompetition(
                [{ type: "Mode", value: "Water" }],
                [zone],
                [{ type: "Mode" }],
            ),
        ).toBe(true);
        expect(matchesTraitCompetition([mode, mode], [zone], [mode])).toBe(
            true,
        );
        expect(
            matchesTraitCompetition([mode, biome], [zone], [mode, biome]),
        ).toBe(false);
        expect(
            matchesTraitCompetition([mode, zone], [zone], [{ type: "Mode" }]),
        ).toBe(false);
        expect(matchesTraitCompetition([mode], [], [mode])).toBe(false);
    });
    it("includes every nonempty subset of the target, independent of order or duplicates", () => {
        for (const criteria of [
            [mode],
            [zone],
            [biome],
            [mode, zone],
            [zone, biome],
            [biome, mode],
            [biome, mode, zone],
            [mode, mode],
        ]) {
            expect(matchesTraitCompetition(criteria, [mode, zone, biome])).toBe(
                true,
            );
        }
    });

    it("excludes narrower, conflicting, unrelated and empty trait scopes", () => {
        for (const criteria of [
            [],
            [biome],
            [mode, biome],
            [zone, { type: "Mode", value: "Water" }],
        ]) {
            expect(matchesTraitCompetition(criteria, [mode, zone])).toBe(false);
        }
        expect(matchesTraitCompetition([mode], [])).toBe(false);
    });

    it("compares exact key/value pairs without ambiguous string keys", () => {
        expect(
            matchesTraitCompetition(
                [{ type: "a|b", value: "c" }],
                [{ type: "a", value: "b|c" }],
            ),
        ).toBe(false);
        expect(
            matchesTraitCompetition(
                [{ type: "Mode", value: "terrain" }],
                [mode],
            ),
        ).toBe(false);
    });
});
