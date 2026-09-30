import { describe, expect, it } from "vitest";
import { BOOTSTRAP_ENUMERATION_MODE as MODE } from "./pipeline.js";
import {
    BOOTSTRAP_MANUAL_RANGE_TOTAL_SUPPLY_LIMIT,
    BOOTSTRAP_MANUAL_TOKEN_IDS_LIMIT,
} from "../config/bootstrap.js";
import { EVM_TOKEN_ID_MAX } from "../evm/token-id.js";
import {
    BOOTSTRAP_SCOPE_FIELD as FIELD,
    BootstrapScopeValidationError,
    parseBootstrapScope,
    bootstrapScopeContainsToken,
    bootstrapScopeTokenCount,
} from "./scope.js";

describe("bootstrap scope admission", () => {
    it("accepts explicit all-contract intent without sample or capability evidence", () => {
        const scope = parseBootstrapScope({ mode: MODE.Enumerable });
        expect(scope).toEqual({ mode: MODE.Enumerable });
        expect(bootstrapScopeContainsToken(scope, "42")).toBe(true);
        expect(bootstrapScopeTokenCount(scope)).toBeNull();
    });
    it.each([
        ["0", 10000],
        ["1", 10000],
        ["163000000", 1000],
        ["0", 1000],
        ["1", 3333],
    ] as const)(
        "preserves declared range %s + %s without reading minted supply",
        (start, count) => {
            const scope = parseBootstrapScope({
                mode: MODE.ManualRange,
                startTokenId: start,
                tokenCount: count,
            });
            expect(scope).toEqual({
                mode: MODE.ManualRange,
                startTokenId: start,
                tokenCount: count,
            });
            expect(bootstrapScopeTokenCount(scope)).toBe(count);
            expect(bootstrapScopeContainsToken(scope, start)).toBe(true);
            expect(
                bootstrapScopeContainsToken(
                    scope,
                    String(BigInt(start) + BigInt(count)),
                ),
            ).toBe(false);
        },
    );
    it("normalizes and deduplicates explicit IDs without sorting them into an inferred range", () => {
        const scope = parseBootstrapScope({
            mode: MODE.ManualTokenIds,
            tokenIds: ["042", "1", "42", "0"],
        });
        expect(scope).toEqual({
            mode: MODE.ManualTokenIds,
            tokenIds: ["42", "1", "0"],
        });
        expect(bootstrapScopeContainsToken(scope, "00042")).toBe(true);
        expect(bootstrapScopeContainsToken(scope, "2")).toBe(false);
        expect(bootstrapScopeTokenCount(scope)).toBe(3);
    });
    it.each([null, undefined, false, "range", {}, { mode: "unsupported" }])(
        "rejects unspecified scope %s",
        (input) => {
            expect(() => parseBootstrapScope(input)).toThrow(
                BootstrapScopeValidationError,
            );
        },
    );
    it("reports both range-field errors together", () => {
        try {
            parseBootstrapScope({
                mode: MODE.ManualRange,
                startTokenId: "bad",
                tokenCount: 0,
            });
            expect.fail("Invalid scope must be rejected");
        } catch (error) {
            expect(error).toMatchObject({
                issues: {
                    [FIELD.StartTokenId]: expect.any(String),
                    [FIELD.TokenCount]: expect.any(String),
                },
            });
        }
    });
    it.each([
        undefined,
        "1",
        NaN,
        Infinity,
        1.5,
        0,
        -1,
        BOOTSTRAP_MANUAL_RANGE_TOTAL_SUPPLY_LIMIT + 1,
    ])("rejects invalid count %s", (tokenCount) => {
        expect(() =>
            parseBootstrapScope({
                mode: MODE.ManualRange,
                startTokenId: "1",
                tokenCount,
            }),
        ).toThrow(BootstrapScopeValidationError);
    });
    it("accepts the request count limit and uint256 endpoint, and rejects a range overflowing it", () => {
        expect(
            bootstrapScopeTokenCount(
                parseBootstrapScope({
                    mode: MODE.ManualRange,
                    startTokenId: "0",
                    tokenCount: BOOTSTRAP_MANUAL_RANGE_TOTAL_SUPPLY_LIMIT,
                }),
            ),
        ).toBe(BOOTSTRAP_MANUAL_RANGE_TOTAL_SUPPLY_LIMIT);
        expect(
            parseBootstrapScope({
                mode: MODE.ManualRange,
                startTokenId: EVM_TOKEN_ID_MAX.toString(),
                tokenCount: 1,
            }),
        ).toMatchObject({ startTokenId: EVM_TOKEN_ID_MAX.toString() });
        expect(() =>
            parseBootstrapScope({
                mode: MODE.ManualRange,
                startTokenId: EVM_TOKEN_ID_MAX.toString(),
                tokenCount: 2,
            }),
        ).toThrow("exceeds the largest token ID");
    });
    it.each([
        undefined,
        "1,2",
        [],
        ["1", "bad"],
        ["1", 2],
        Array(BOOTSTRAP_MANUAL_TOKEN_IDS_LIMIT + 1).fill("1"),
    ])("rejects malformed or oversized explicit lists (%#)", (tokenIds) => {
        expect(() =>
            parseBootstrapScope({ mode: MODE.ManualTokenIds, tokenIds }),
        ).toThrow(BootstrapScopeValidationError);
    });
    it("accepts the explicit request limit and applies uniqueness to the selected count", () => {
        const scope = parseBootstrapScope({
            mode: MODE.ManualTokenIds,
            tokenIds: Array(BOOTSTRAP_MANUAL_TOKEN_IDS_LIMIT).fill("1"),
        });
        expect(bootstrapScopeTokenCount(scope)).toBe(1);
    });
});
