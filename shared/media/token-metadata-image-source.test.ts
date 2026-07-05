import { describe, expect, it } from "vitest";
import {
    TOKEN_METADATA_IMAGE_SOURCE_FIELD,
    selectTokenMetadataImageSource,
} from "./token-metadata-image-source.js";

// Arbitrary field name used to prove explicit user overrides are not limited.
const TEST_REQUESTED_IMAGE_SOURCE_FIELD = "animation_url";
// Arbitrary image-looking field used to prove last-resort field scanning works.
const TEST_FALLBACK_IMAGE_SOURCE_FIELD = "media";

describe("token metadata image source selection", () => {
    it("uses onchain image_data after canonical image fields are absent", () => {
        const selected = selectTokenMetadataImageSource({
            metadata: {
                [TOKEN_METADATA_IMAGE_SOURCE_FIELD.ImageData]:
                    "data:image/svg+xml;base64,PHN2Zy8+",
            },
        });

        expect(selected).toEqual({
            field: TOKEN_METADATA_IMAGE_SOURCE_FIELD.ImageData,
            value: "data:image/svg+xml;base64,PHN2Zy8+",
        });
    });

    it("uses svg_image_data as a preferred onchain image source", () => {
        const selected = selectTokenMetadataImageSource({
            metadata: {
                [TOKEN_METADATA_IMAGE_SOURCE_FIELD.SvgImageData]:
                    "data:image/svg+xml,%3Csvg%2F%3E",
            },
        });

        expect(selected).toEqual({
            field: TOKEN_METADATA_IMAGE_SOURCE_FIELD.SvgImageData,
            value: "data:image/svg+xml,%3Csvg%2F%3E",
        });
    });

    it("respects an explicit image source field when it contains a supported URI", () => {
        const selected = selectTokenMetadataImageSource({
            metadata: {
                [TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image]:
                    "https://example.com/preview.png",
                [TEST_REQUESTED_IMAGE_SOURCE_FIELD]: "ipfs://QmOriginal",
            },
            requestedField: TEST_REQUESTED_IMAGE_SOURCE_FIELD,
        });

        expect(selected).toEqual({
            field: TEST_REQUESTED_IMAGE_SOURCE_FIELD,
            value: "ipfs://QmOriginal",
        });
    });

    it("falls back to fields whose values clearly point to image media", () => {
        const selected = selectTokenMetadataImageSource({
            metadata: {
                [TEST_FALLBACK_IMAGE_SOURCE_FIELD]:
                    "https://example.com/token/1.svg?cache=1",
            },
        });

        expect(selected).toEqual({
            field: TEST_FALLBACK_IMAGE_SOURCE_FIELD,
            value: "https://example.com/token/1.svg?cache=1",
        });
    });
});
