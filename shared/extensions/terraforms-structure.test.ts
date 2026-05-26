import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import {
    buildTerraformsLevelSummary,
    resolveTerraformsTopographyBucket,
    resolveTerraformsZoneIndexForTopographyBucket,
    TERRAFORMS_BIOMES,
    TERRAFORMS_BIOME_ATTRIBUTE_KEY,
    TERRAFORMS_BIOME_GROUPS,
    TERRAFORMS_BIOME_GROUP_WEIGHTS_BY_LEVEL,
    TERRAFORMS_HYPERCASTLE_LEVELS,
    TERRAFORMS_HYPERCASTLE_LEVEL_GROUPS,
    TERRAFORMS_HYPERCASTLE_TOTAL_PARCELS,
    TERRAFORMS_LEVEL_DIMENSIONS,
    TERRAFORMS_RESOURCE_ATTRIBUTE_KEY,
    TERRAFORMS_TOPOGRAPHY_BUCKETS,
    TERRAFORMS_ZONES,
    TERRAFORMS_ZONE_ATTRIBUTE_KEY,
} from "./terraforms-structure.js";

describe("Terraforms Hypercastle static structure", () => {
    it("mirrors contract level dimensions and total parcel count", () => {
        assert.equal(TERRAFORMS_HYPERCASTLE_LEVELS.length, 20);
        assert.deepEqual(TERRAFORMS_LEVEL_DIMENSIONS, [
            4, 8, 8, 16, 16, 24, 24, 24, 16, 32, 32, 16, 48, 48, 24, 24, 16,
            8, 8, 4,
        ]);
        assert.equal(TERRAFORMS_HYPERCASTLE_TOTAL_PARCELS, 11104);
        assert.equal(TERRAFORMS_HYPERCASTLE_LEVELS[12].parcelCount, 2304);
        assert.equal(TERRAFORMS_HYPERCASTLE_LEVELS[13].parcelCount, 2304);
    });

    it("mirrors contract Zones and 10-color palettes", () => {
        assert.equal(TERRAFORMS_ZONES.length, 75);
        assert.equal(new Set(TERRAFORMS_ZONES.map((zone) => zone.name)).size, 75);
        assert.equal(TERRAFORMS_ZONES[0].name, "Alto");
        assert.equal(TERRAFORMS_ZONES[74].name, "Kairo");

        for (const zone of TERRAFORMS_ZONES) {
            assert.equal(zone.palette.length, 10, zone.name);
            assert.match(zone.palette[0], /^#[0-9a-f]{6}$/i);
        }
    });

    it("mirrors contract Biomes, character sets, and font metadata", () => {
        assert.equal(TERRAFORMS_BIOMES.length, 92);
        assert.equal(TERRAFORMS_BIOMES[0].fontId, 0);
        assert.equal(TERRAFORMS_BIOMES[0].fontSize, 27);
        assert.equal(TERRAFORMS_BIOMES[91].fontId, 1);
        assert.equal(TERRAFORMS_BIOMES[91].fontSize, 14);

        for (const biome of TERRAFORMS_BIOMES) {
            assert.equal(biome.characters.length, 9, String(biome.index));
            assert.equal(biome.groupIndex, resolveExpectedBiomeGroup(biome.index));
        }
    });

    it("builds biome groups and per-level contract weights", () => {
        assert.deepEqual(
            TERRAFORMS_BIOME_GROUPS.map((group) => [
                group.startIndex,
                group.length,
            ]),
            [
                [0, 21],
                [21, 22],
                [43, 7],
                [50, 9],
                [59, 7],
                [66, 7],
                [73, 4],
                [77, 6],
                [83, 9],
            ],
        );

        for (const levelWeights of TERRAFORMS_BIOME_GROUP_WEIGHTS_BY_LEVEL) {
            assert.equal(
                levelWeights.reduce<number>((sum, weight) => sum + weight, 0),
                100,
            );
        }

        assert.deepEqual(
            TERRAFORMS_HYPERCASTLE_LEVELS[0].availableBiomeGroupWeights.map(
                (weight) => [weight.groupIndex, weight.weightPercent],
            ),
            [
                [1, 50],
                [8, 50],
            ],
        );
    });

    it("mirrors contract topography threshold and Zone selection rules", () => {
        assert.equal(TERRAFORMS_TOPOGRAPHY_BUCKETS.length, 9);
        assert.equal(resolveTerraformsTopographyBucket(18001), 0);
        assert.equal(resolveTerraformsTopographyBucket(18000), 1);
        assert.equal(resolveTerraformsTopographyBucket(-25999), 7);
        assert.equal(resolveTerraformsTopographyBucket(-26000), 8);

        assert.equal(
            resolveTerraformsZoneIndexForTopographyBucket({
                levelNumber: 13,
                topographyBucketIndex: 0,
            }),
            25,
        );
        assert.equal(
            resolveTerraformsZoneIndexForTopographyBucket({
                levelNumber: 13,
                topographyBucketIndex: 8,
            }),
            33,
        );
        assert.equal(
            resolveTerraformsZoneIndexForTopographyBucket({
                levelNumber: 10,
                topographyBucketIndex: 8,
            }),
            43,
        );
    });

    it("builds level summaries and Zone-set groups without token records", () => {
        const firstLevel = buildTerraformsLevelSummary(1);
        assert.equal(firstLevel.zones.length, 1);
        assert.equal(firstLevel.zones[0].name, "Kairo");
        assert.equal(firstLevel.topographyZoneBuckets.length, 9);

        const thirteenthLevel = buildTerraformsLevelSummary(13);
        assert.deepEqual(
            thirteenthLevel.zones.map((zone) => zone.name),
            [
                "Mecha",
                "Grove",
                "Nightrose",
                "Hypermage",
                "Arc",
                "Dynacrypts",
                "Aetherking",
                "Valeria",
                "Killscreen",
            ],
        );

        assert.equal(TERRAFORMS_HYPERCASTLE_LEVEL_GROUPS.length, 14);
        assert.deepEqual(
            TERRAFORMS_HYPERCASTLE_LEVEL_GROUPS[0].levelNumbers,
            [1, 2, 3, 4],
        );
        assert.deepEqual(TERRAFORMS_HYPERCASTLE_LEVEL_GROUPS[0].zoneNames, [
            "Kairo",
        ]);
        assert.deepEqual(
            TERRAFORMS_HYPERCASTLE_LEVEL_GROUPS[13].levelNumbers,
            [17, 18, 19, 20],
        );
        assert.deepEqual(TERRAFORMS_HYPERCASTLE_LEVEL_GROUPS[13].zoneNames, [
            "Alto",
        ]);
    });

    it("centralizes Terraforms ArtGod-facing metadata trait keys", () => {
        assert.equal(TERRAFORMS_RESOURCE_ATTRIBUTE_KEY, "Resource");
        assert.equal(TERRAFORMS_ZONE_ATTRIBUTE_KEY, "Zone");
        assert.equal(TERRAFORMS_BIOME_ATTRIBUTE_KEY, "Biome");
    });
});

function resolveExpectedBiomeGroup(biomeIndex: number): number {
    return TERRAFORMS_BIOME_GROUPS.find(
        (group) =>
            biomeIndex >= group.startIndex &&
            biomeIndex < group.startIndex + group.length,
    )?.groupIndex as number;
}
