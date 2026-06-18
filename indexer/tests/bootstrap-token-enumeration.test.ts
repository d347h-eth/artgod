import { describe, expect, it } from "vitest";
import { BOOTSTRAP_ENUMERATION_MODE } from "@artgod/shared/bootstrap/pipeline";
import { resolveManualBootstrapTokenIds } from "../src/application/bootstrap-token-enumeration.js";

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
            resolveManualBootstrapTokenIds({
                enumerationMode: BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds,
                manualTokenIdsJson: JSON.stringify([" 1 ", "42", "9000"]),
                manualRangeStartTokenId: null,
                manualRangeTotalSupply: null,
            }),
        ).toEqual(["1", "42", "9000"]);
    });

    it("expands manual token ranges from the configured start token", () => {
        expect(
            resolveManualBootstrapTokenIds({
                enumerationMode: BOOTSTRAP_ENUMERATION_MODE.ManualRange,
                manualTokenIdsJson: null,
                manualRangeStartTokenId: "100",
                manualRangeTotalSupply: 3,
            }),
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
});
