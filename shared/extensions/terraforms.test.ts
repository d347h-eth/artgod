import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import {
    hashTerraformsCanvasRows,
    isTerraformsDreamMode,
    parseTerraformsCanvasRowsText,
    TERRAFORMS_MODE_ATTRIBUTE_VALUES,
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
});
