import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
    buildImageDataUri,
    parseImageDataUriBuffer,
    parseJsonDataUriText,
    resolveTokenResourceUri,
} from "./token-resource-uri.js";

describe("token resource URI helpers", () => {
    it("normalizes IPFS URIs through a configured gateway origin", () => {
        expect(
            resolveTokenResourceUri("ipfs://ipfs/QmHash/metadata 1.json", {
                ipfsGatewayOrigin: "https://gateway.example/ipfs",
            }),
        ).toBe("https://gateway.example/ipfs/QmHash/metadata%201.json");
    });

    it("decodes JSON and image data URIs", () => {
        expect(
            parseJsonDataUriText(
                "data:application/json;charset=utf-8,%7B%22name%22%3A%22token%22%7D",
            ),
        ).toBe('{"name":"token"}');

        const image = parseImageDataUriBuffer(
            "data:image/png;base64,aGVsbG8=",
        );
        expect(image.contentType).toBe("image/png");
        expect(image.buffer.toString("utf8")).toBe("hello");
    });

    it("encodes image bytes as a data URI", () => {
        expect(
            buildImageDataUri({
                contentType: "image/webp",
                buffer: Buffer.from("cache-preview", "utf8"),
            }),
        ).toBe("data:image/webp;base64,Y2FjaGUtcHJldmlldw==");
    });
});
