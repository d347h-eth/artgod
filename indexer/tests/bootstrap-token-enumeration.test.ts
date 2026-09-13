import { describe, expect, it } from "vitest";
import { BOOTSTRAP_ENUMERATION_MODE } from "@artgod/shared/bootstrap/pipeline";
import {
    resolveManualBootstrapTokenIds,
    resolvePresentBootstrapTokenIds,
} from "../src/application/bootstrap-token-enumeration.js";

describe("bootstrap token enumeration", () => {
    it("leaves enumerable collections for the RPC-backed path", () => {
        expect(
            resolveManualBootstrapTokenIds({
                enumerationMode: BOOTSTRAP_ENUMERATION_MODE.Enumerable,
                manualTokenIdsJson: null,
                manualRangeStartTokenId: null,
                manualRangeTotalSupply: null,
            }),
        ).toBeNull();
    });

    it("parses explicit manual token ids", () => {
        expect(
            Array.from(
                resolveManualBootstrapTokenIds({
                    enumerationMode: BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds,
                    manualTokenIdsJson: JSON.stringify([" 1 ", "42", "9000"]),
                    manualRangeStartTokenId: null,
                    manualRangeTotalSupply: null,
                })!,
            ),
        ).toEqual(["1", "42", "9000"]);
    });

    it("expands manual token ranges from the configured start token", () => {
        expect(
            Array.from(
                resolveManualBootstrapTokenIds({
                    enumerationMode: BOOTSTRAP_ENUMERATION_MODE.ManualRange,
                    manualTokenIdsJson: null,
                    manualRangeStartTokenId: "100",
                    manualRangeTotalSupply: 3,
                })!,
            ),
        ).toEqual(["100", "101", "102"]);
    });

    it("rejects empty or non-numeric manual token ids", () => {
        expect(() =>
            resolveManualBootstrapTokenIds({
                enumerationMode: BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds,
                manualTokenIdsJson: JSON.stringify([]),
                manualRangeStartTokenId: null,
                manualRangeTotalSupply: null,
            }),
        ).toThrow("manual token ids payload is empty");

        expect(() =>
            resolveManualBootstrapTokenIds({
                enumerationMode: BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds,
                manualTokenIdsJson: JSON.stringify(["1", "abc"]),
                manualRangeStartTokenId: null,
                manualRangeTotalSupply: null,
            }),
        ).toThrow("manual token ids payload contains invalid token id");
    });

    it("rejects incomplete manual token ranges", () => {
        expect(() =>
            resolveManualBootstrapTokenIds({
                enumerationMode: BOOTSTRAP_ENUMERATION_MODE.ManualRange,
                manualTokenIdsJson: null,
                manualRangeStartTokenId: "100",
                manualRangeTotalSupply: 0,
            }),
        ).toThrow("manual token range requires start token id and supply");
    });
    it("only seeds minted tokens within the user range", async () => {
        const calls: string[] = [];
        const result = await resolvePresentBootstrapTokenIds(
            ["1", "2", "3"],
            async (tokenId) => {
                calls.push(tokenId);
                return tokenId === "2" ? "owner" : null;
            },
        );
        expect(result).toEqual(["2"]);
        expect(calls).toEqual(["1", "2", "3"]);
    });
    it("does not silently skip uncertain ownership failures", async () => {
        const failure = new Error("provider timeout");
        await expect(
            resolvePresentBootstrapTokenIds(["1", "2"], async () => {
                throw failure;
            }),
        ).rejects.toBe(failure);
    });
    it("rejects an entirely unminted scope", async () => {
        await expect(
            resolvePresentBootstrapTokenIds(["1"], async () => null),
        ).rejects.toThrow("No tokens exist");
    });
});
