import { describe, expect, it } from "vitest";
import { inspectBootstrapMetadata } from "./metadata.js";

const gateway = "https://ipfs.filebase.io";
const inspect = (value: unknown) =>
    inspectBootstrapMetadata({
        text: JSON.stringify(value),
        ipfsGatewayOrigin: gateway,
    });
describe("bootstrap metadata selection without network calls", () => {
    it.each([null, [], 42, "", true])("rejects non-object JSON %j", (value) => {
        expect(inspect(value).error).toContain("JSON object");
    });
    it("keeps missing, malformed and usable JSON separate", () => {
        expect(
            inspectBootstrapMetadata({ text: null, ipfsGatewayOrigin: gateway })
                .error,
        ).toBeNull();
        expect(
            inspectBootstrapMetadata({
                text: "{broken",
                ipfsGatewayOrigin: gateway,
            }).error,
        ).toContain("JSON object");
        expect(inspect({})).toMatchObject({
            image: null,
            animationUrl: null,
            name: null,
            error: null,
        });
    });
    it("re-selects explicit media fields while retaining original text", () => {
        const text = JSON.stringify({
            name: "art",
            image: "ipfs://abc/1",
            animation_url: "https://example.com/a",
            alternate: "https://example.com/x.png",
            bad: 42,
        });
        expect(
            inspectBootstrapMetadata({ text, ipfsGatewayOrigin: gateway }),
        ).toMatchObject({
            name: "art",
            imageSourceField: "image",
            image: gateway + "/ipfs/abc/1",
            animationSourceField: "animation_url",
        });
        expect(
            inspectBootstrapMetadata({
                text,
                ipfsGatewayOrigin: gateway,
                imageSourceField: "alternate",
                animationSourceField: "bad",
            }),
        ).toMatchObject({ imageSourceField: "alternate", animationUrl: null });
        expect(
            inspectBootstrapMetadata({
                text,
                ipfsGatewayOrigin: gateway,
                imageSourceField: "missing",
            }).image,
        ).toBeNull();
        expect(
            inspect({
                name: 1,
                image_data: "data:image/svg+xml,%3Csvg%3E%3C/svg%3E",
            }),
        ).toMatchObject({ name: null, imageSourceField: "image_data" });
    });
});
