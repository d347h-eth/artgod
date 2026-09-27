import { describe, expect, it } from "vitest";
import { EVM_TOKEN_ID_MAX, normalizeEvmTokenId } from "./token-id.js";

describe("ERC721 decimal token IDs", () => {
    it.each([
        ["0", "0"],
        [" 0001 ", "1"],
        ["163000000", "163000000"],
        [EVM_TOKEN_ID_MAX.toString(), EVM_TOKEN_ID_MAX.toString()],
    ])("normalizes valid ID %s without precision loss", (input, expected) => {
        expect(normalizeEvmTokenId(input)).toBe(expected);
    });
    it.each([
        undefined,
        null,
        1,
        1n,
        {},
        "",
        " ",
        "-1",
        "+1",
        "1.5",
        "1e3",
        "0x1",
        "abc",
        "1".repeat(79),
        (EVM_TOKEN_ID_MAX + 1n).toString(),
    ])("rejects invalid ID %s", (input) =>
        expect(normalizeEvmTokenId(input)).toBeNull(),
    );
});
