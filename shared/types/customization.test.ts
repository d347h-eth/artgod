import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { renderTraitSummaryTemplate } from "./customization.js";

describe("trait summary templates", () => {
    it("renders placeholders mixed with literal text", () => {
        assert.equal(
            renderTraitSummaryTemplate("{Zone} B{Biome}", [
                { key: "Zone", value: "Kairo" },
                { key: "Biome", value: "12" },
            ]),
            "Kairo B12",
        );
    });

    it("renders equality and presence conditionals", () => {
        assert.equal(
            renderTraitSummaryTemplate(
                "{Mode}{{#if Antenna=On}} A{{/if}}{{#if Seasons=Season 0}} S0{{/if}}{{#if Seed Class}} {Seed Class}{{/if}}",
                [
                    { key: "Mode", value: "Daydream" },
                    { key: "Antenna", value: "On" },
                    { key: "Seasons", value: "Season 0" },
                    { key: "Seed Class", value: "Y-Seed" },
                ],
            ),
            "Daydream A S0 Y-Seed",
        );
    });

    it("omits conditional bodies when traits are absent or do not match", () => {
        assert.equal(
            renderTraitSummaryTemplate(
                "{Mode}{{#if Antenna=On}} A{{/if}}{{#if Seasons=Season 0}} S0{{/if}}{{#if Seed Class}} {Seed Class}{{/if}}",
                [
                    { key: "Mode", value: "Terrain" },
                    { key: "Antenna", value: "Off" },
                ],
            ),
            "Terrain",
        );
    });

    it("preserves internal line breaks", () => {
        assert.equal(
            renderTraitSummaryTemplate("{Zone} B{Biome}\n{Mode}", [
                { key: "Zone", value: "Kairo" },
                { key: "Biome", value: "12" },
                { key: "Mode", value: "Terrain" },
            ]),
            "Kairo B12\nTerrain",
        );
    });

    it("trims leading whitespace left by missing placeholders", () => {
        assert.equal(
            renderTraitSummaryTemplate("{Missing}\n{Mode}", [
                { key: "Mode", value: "Terrain" },
            ]),
            "Terrain",
        );
    });
});
