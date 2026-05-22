import { describe, expect, it } from "vitest";
import { sanitizeHttpRequestTarget } from "./http.js";

describe("HTTP observability metadata", () => {
    it("keeps only allowlisted query keys and drops origins and query values", () => {
        expect(
            sanitizeHttpRequestTarget(
                "http://127.0.0.1:3000/api/ethereum/blockspace?collection=terraforms&page_start=1&0xsecret=value",
            ),
        ).toEqual({
            path: "/api/ethereum/blockspace",
            queryKeys: ["collection", "page_start"],
            queryParamCount: 3,
            redactedQueryParamCount: 1,
        });
    });
});
