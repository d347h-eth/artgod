import { describe, expect, it } from "vitest";
import {
    buildProbeBootstrapOpenSeaSlugPath,
    BOOTSTRAP_API_QUERY_PARAM,
} from "../http/bootstrap-routes.js";

describe("OpenSea sample probe request", () => {
    it("carries exactly the submitted sample independently of collection boundaries", () => {
        const url = new URL(
            buildProbeBootstrapOpenSeaSlugPath({
                chainRef: "ethereum",
                address: "0x1111111111111111111111111111111111111111",
                sampleTokenId: "2",
                slug: "shared-project",
            }),
            "http://localhost",
        );
        expect(
            url.searchParams.getAll(BOOTSTRAP_API_QUERY_PARAM.SampleTokenId),
        ).toEqual(["2"]);
        expect([...url.searchParams.keys()]).toEqual([
            BOOTSTRAP_API_QUERY_PARAM.Address,
            BOOTSTRAP_API_QUERY_PARAM.Slug,
            BOOTSTRAP_API_QUERY_PARAM.SampleTokenId,
        ]);
    });
});
