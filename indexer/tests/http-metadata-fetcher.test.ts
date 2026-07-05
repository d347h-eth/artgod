import { describe, expect, it } from "vitest";
import { TOKEN_METADATA_IMAGE_SOURCE_FIELD } from "@artgod/shared/media/token-metadata-image-source";
import { HttpMetadataFetcher } from "../src/infra/metadata/http-fetcher.js";

describe("HttpMetadataFetcher", () => {
    it("uses requested bootstrap image source field for canonical image", async () => {
        const imageData = "data:image/svg+xml;base64,PHN2Zy8+";
        const uri = `data:application/json,${encodeURIComponent(
            JSON.stringify({
                [TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image]:
                    "https://example.com/preview.png",
                [TOKEN_METADATA_IMAGE_SOURCE_FIELD.SvgImageData]: imageData,
            }),
        )}`;
        const fetcher = new HttpMetadataFetcher();

        const metadata = await fetcher.fetchMetadata(uri, {
            imageSourceField: TOKEN_METADATA_IMAGE_SOURCE_FIELD.SvgImageData,
        });

        expect(metadata?.image).toBe(imageData);
    });
});
