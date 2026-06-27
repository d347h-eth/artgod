import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import {
    buildTerraformsUnmintedTokenId,
    buildTerraformsRendererExtraCharacterRanges,
    calculateTerraformsRendererSeed,
    hashTerraformsCanvasRows,
    isTerraformsDreamMode,
    parseTerraformsUnmintedTokenId,
    parseTerraformsCanvasRowsText,
    resolveTerraformsLevelAndTileFromPlacement,
    resolveTerraformsRendererSeedClass,
    resolveTerraformsUnmintedPlacements,
    TERRAFORMS_MAX_SUPPLY,
    TERRAFORMS_MODE_ATTRIBUTE_VALUES,
    TERRAFORMS_RENDERER_EXTRA_CHARACTER_RANGE_LENGTH,
    TERRAFORMS_RENDERER_EXTRA_CHARACTER_RANGE_STARTS,
    TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES,
} from "./terraforms.js";

describe("Terraforms canvas helpers", () => {
    it("hashes pasted decimal canvas rows with the canonical uint256[16] encoding", () => {
        const rows = parseTerraformsCanvasRowsText(
            Array.from({ length: 16 }, (_, index) => String(index + 1)).join(
                "\n",
            ),
        );

        assert.equal(
            hashTerraformsCanvasRows(rows),
            "0xf2195b02971f2ea2803b2195c5862918df0320b990fb97dfbfcdb48a87b83234",
        );
    });

    it("accepts single-line pasted canvas rows separated by whitespace", () => {
        const rows = parseTerraformsCanvasRowsText(
            Array.from({ length: 16 }, (_, index) => String(index + 1)).join(
                " ",
            ),
        );

        assert.equal(
            hashTerraformsCanvasRows(rows),
            "0xf2195b02971f2ea2803b2195c5862918df0320b990fb97dfbfcdb48a87b83234",
        );
    });

    it("rejects incomplete pasted canvas rows", () => {
        assert.throws(() => parseTerraformsCanvasRowsText("1\n2\n3"), {
            message: "Terraforms heightmap must contain exactly 16 rows",
        });
    });

    it("marks only dream-capable Terraforms modes as dream modes", () => {
        assert.equal(
            isTerraformsDreamMode(TERRAFORMS_MODE_ATTRIBUTE_VALUES.Terrain),
            false,
        );
        assert.equal(
            isTerraformsDreamMode(TERRAFORMS_MODE_ATTRIBUTE_VALUES.Daydream),
            true,
        );
        assert.equal(
            isTerraformsDreamMode(TERRAFORMS_MODE_ATTRIBUTE_VALUES.Terraform),
            true,
        );
        assert.equal(
            isTerraformsDreamMode(
                TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginDaydream,
            ),
            true,
        );
        assert.equal(
            isTerraformsDreamMode(
                TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginTerraform,
            ),
            true,
        );
    });

    it("mirrors Terraforms placement rotation into zero-based renderer level/tile", () => {
        assert.deepEqual(resolveTerraformsLevelAndTileFromPlacement(0n), {
            level: 15n,
            tile: 68n,
        });
        assert.deepEqual(resolveTerraformsLevelAndTileFromPlacement(907n), {
            level: 19n,
            tile: 15n,
        });
        assert.deepEqual(resolveTerraformsLevelAndTileFromPlacement(11103n), {
            level: 15n,
            tile: 67n,
        });
    });

    it("builds and parses extension-owned unminted token ids", () => {
        assert.equal(buildTerraformsUnmintedTokenId(42n), "unminted-tile-42");
        assert.equal(parseTerraformsUnmintedTokenId("unminted-tile-42"), 42n);
        assert.equal(parseTerraformsUnmintedTokenId("42"), null);
        assert.equal(parseTerraformsUnmintedTokenId("unminted-tile-x"), null);
        assert.throws(() => buildTerraformsUnmintedTokenId(-1n), {
            message: "Terraforms placement -1 is out of range",
        });
        assert.throws(() =>
            parseTerraformsUnmintedTokenId(
                `unminted-tile-${TERRAFORMS_MAX_SUPPLY}`,
            ),
        );
    });

    it("computes unminted placement complements inside Terraforms max supply", () => {
        const unminted = resolveTerraformsUnmintedPlacements([0n, 2n, 2n]);

        assert.equal(unminted.length, TERRAFORMS_MAX_SUPPLY - 2);
        assert.deepEqual(unminted.slice(0, 3), [1n, 3n, 4n]);
        assert.equal(unminted[unminted.length - 1], 11103n);
    });

    it("calculates the hidden renderer seed with Solidity packed encoding", () => {
        assert.equal(calculateTerraformsRendererSeed(0n, 0n), 4117n);
        assert.equal(calculateTerraformsRendererSeed(0n, 1n), 6217n);
        assert.equal(calculateTerraformsRendererSeed(12n, 0n), 7887n);
    });

    it("classifies Terraforms renderer seed buckets by origin mode and seed range", () => {
        assert.equal(
            resolveTerraformsRendererSeedClass({
                mode: TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginDaydream,
                seed: 9951n,
            }),
            TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.Godmode,
        );
        assert.equal(
            resolveTerraformsRendererSeedClass({
                mode: TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginTerraform,
                seed: 9970n,
            }),
            TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.Godmode,
        );
        assert.equal(
            resolveTerraformsRendererSeedClass({
                mode: TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginDaydream,
                seed: 9983n,
            }),
            TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.Godmode,
        );
        assert.equal(
            resolveTerraformsRendererSeedClass({
                mode: TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginDaydream,
                seed: 9001n,
            }),
            TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed,
        );
        assert.equal(
            resolveTerraformsRendererSeedClass({
                mode: TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginTerraform,
                seed: 9950n,
            }),
            TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed,
        );
        assert.equal(
            resolveTerraformsRendererSeedClass({
                mode: TERRAFORMS_MODE_ATTRIBUTE_VALUES.Terrain,
                seed: 9971n,
            }),
            TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed,
        );
        assert.equal(
            resolveTerraformsRendererSeedClass({
                mode: TERRAFORMS_MODE_ATTRIBUTE_VALUES.Terrain,
                seed: 9951n,
            }),
            TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.YSeed,
        );
        assert.equal(
            resolveTerraformsRendererSeedClass({
                mode: TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginDaydream,
                seed: 9000n,
            }),
            null,
        );
        assert.equal(
            resolveTerraformsRendererSeedClass({
                mode: TERRAFORMS_MODE_ATTRIBUTE_VALUES.Terrain,
                seed: 9950n,
            }),
            null,
        );
    });

    it("builds renderer extra character ranges with V2 fromCharCode semantics", () => {
        const ranges = buildTerraformsRendererExtraCharacterRanges();

        assert.equal(
            ranges.length,
            TERRAFORMS_RENDERER_EXTRA_CHARACTER_RANGE_STARTS.length,
        );
        assert.equal(
            ranges.every(
                (range) =>
                    range.length ===
                    TERRAFORMS_RENDERER_EXTRA_CHARACTER_RANGE_LENGTH,
            ),
            true,
        );
        assert.deepEqual(ranges[0], [
            "▀",
            "▁",
            "▂",
            "▃",
            "▄",
            "▅",
            "▆",
            "▇",
            "█",
            "▉",
        ]);
        assert.equal(ranges[7]?.[0], "⿱");
        assert.equal(ranges[17]?.[5], "⬅");
        assert.equal(ranges[18]?.[0], "⬅");
    });
});
