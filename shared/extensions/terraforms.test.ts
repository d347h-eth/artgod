import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import {
    calculateTerraformsRendererSeed,
    hashTerraformsCanvasRows,
    isTerraformsDreamMode,
    parseTerraformsCanvasRowsText,
    resolveTerraformsLevelAndTileFromPlacement,
    resolveTerraformsRendererSeedClass,
    TERRAFORMS_MODE_ATTRIBUTE_VALUES,
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
});
