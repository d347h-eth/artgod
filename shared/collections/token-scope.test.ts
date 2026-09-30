import { describe, expect, it } from "vitest";
import { EVM_TOKEN_ID_MAX } from "../evm/token-id.js";
import {
    COLLECTION_TOKEN_SCOPE_KIND as KIND,
    CollectionTokenScope,
} from "./token-scope.js";

describe("declared collection token scope", () => {
    it("preserves the declared sparse range, including currently unminted low IDs", () => {
        const scope = CollectionTokenScope.tokenRange("000", 1000);
        expect(scope.scopeStartTokenId).toBe("0");
        expect(scope.scopeTotalSupply).toBe(1000);
        expect(scope.isTokenRangeScope()).toBe(true);
        expect(scope.isAllContractTokensScope()).toBe(false);
        expect(scope.isExplicitTokenIdsScope()).toBe(false);
        expect(scope.containsToken("0")).toBe(true);
        expect(scope.containsToken("999")).toBe(true);
        expect(scope.containsToken("1000")).toBe(false);
        expect(scope.containsToken("invalid")).toBe(false);
    });

    it("keeps Meridian's project boundaries independent of contract inventory", () => {
        const scope = CollectionTokenScope.tokenRange("163000000", 1000);
        expect(scope.containsToken("162999999")).toBe(false);
        expect(scope.containsToken("163000000")).toBe(true);
        expect(scope.containsToken("163000999")).toBe(true);
        expect(scope.containsToken("163001000")).toBe(false);
    });

    it("uses canonical token membership for explicit lists", () => {
        const scope = CollectionTokenScope.explicitTokenIds();
        expect(scope.isExplicitTokenIdsScope()).toBe(true);
        expect(scope.isTokenRangeScope()).toBe(false);
        expect(scope.containsToken("001", (id) => id === "1")).toBe(true);
        expect(scope.containsToken("2", (id) => id === "1")).toBe(false);
        expect(scope.containsToken("1")).toBe(false);
        expect(scope.scopeStartTokenId).toBeNull();
        expect(scope.scopeTotalSupply).toBeNull();
    });

    it("represents all contract tokens without manufacturing a numeric boundary", () => {
        const scope = CollectionTokenScope.allContractTokens();
        expect(scope.isAllContractTokensScope()).toBe(true);
        expect(scope.containsToken("42")).toBe(true);
        expect(scope.containsToken(EVM_TOKEN_ID_MAX.toString())).toBe(true);
        expect(scope.containsToken("-1")).toBe(false);
        expect(scope.scopeStartTokenId).toBeNull();
        expect(scope.scopeTotalSupply).toBeNull();
    });

    it.each([
        [KIND.AllContractTokens, null, null],
        [KIND.ExplicitTokenIds, null, null],
        [KIND.TokenRange, "1", 3333],
    ])("round trips the existing %s storage contract", (kind, start, count) => {
        const row = {
            tokenScopeKind: kind,
            scopeStartTokenId: start,
            scopeTotalSupply: count,
        };
        expect(
            CollectionTokenScope.fromPersistence(row).toPersistence(),
        ).toEqual(row);
    });

    it("rejects unknown stored scope kinds", () => {
        expect(() =>
            CollectionTokenScope.fromPersistence({
                tokenScopeKind: "unknown",
                scopeStartTokenId: null,
                scopeTotalSupply: null,
            }),
        ).toThrow("Unknown collection token scope kind");
    });

    it.each([
        [null, 1],
        ["bad", 1],
        ["1", null],
        ["1", 0],
        ["1", -1],
        ["1", 1.5],
        ["1", Number.MAX_SAFE_INTEGER + 1],
        [EVM_TOKEN_ID_MAX.toString(), 2],
    ])("rejects invalid range start %s and count %s", (start, count) => {
        expect(() =>
            CollectionTokenScope.tokenRange(
                start as string | null,
                count as number | null,
            ),
        ).toThrow();
    });

    it("accepts a single token at the uint256 upper boundary", () => {
        expect(
            CollectionTokenScope.tokenRange(
                EVM_TOKEN_ID_MAX.toString(),
                1,
            ).containsToken(EVM_TOKEN_ID_MAX.toString()),
        ).toBe(true);
    });

    it.each([
        ["0", "5", null],
        ["10", "15", { fromTokenId: "10", toTokenId: "15" }],
        ["12", "25", { fromTokenId: "12", toTokenId: "19" }],
        ["0", "100", { fromTokenId: "10", toTokenId: "19" }],
        ["30", "40", null],
        ["bad", "10", null],
        ["1", "bad", null],
        ["20", "10", null],
    ])(
        "intersects an event range %s..%s with declared IDs 10..19",
        (from, to, expected) => {
            expect(
                CollectionTokenScope.tokenRange(
                    "10",
                    10,
                ).intersectContinuousRange(from as string, to as string),
            ).toEqual(expected);
        },
    );

    it("preserves all-contract intervals and does not invent explicit-list intervals", () => {
        expect(
            CollectionTokenScope.allContractTokens().intersectContinuousRange(
                "001",
                "010",
            ),
        ).toEqual({ fromTokenId: "1", toTokenId: "10" });
        expect(
            CollectionTokenScope.explicitTokenIds().intersectContinuousRange(
                "1",
                "10",
            ),
        ).toBeNull();
    });
});
