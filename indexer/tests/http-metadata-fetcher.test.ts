import cambriaMetadata from "./fixtures/cambria-charter-1997-metadata.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import { TOKEN_METADATA_ANIMATION_SOURCE_FIELD } from "@artgod/shared/media/token-metadata-animation-source";
import { TOKEN_METADATA_IMAGE_SOURCE_FIELD } from "@artgod/shared/media/token-metadata-image-source";
import { HttpMetadataFetcher } from "../src/infra/metadata/http-fetcher.js";
import {
    TOKEN_METADATA_ATTRIBUTE_CONTAINER_FIELD,
    TOKEN_METADATA_ATTRIBUTE_ITEM_FIELD,
} from "../src/domain/metadata.js";

const TEST_HEURISTIC_ATTRIBUTE_CONTAINER_FIELD = "properties";
const TEST_EXPLICIT_TRAIT_CONTAINER_FIELD = "details";
const TEST_FEATURE_ATTRIBUTE_KEY_WITH_SPACE = "Brush Style";
const TEST_FEATURE_ATTRIBUTE_KEY_WITH_PIPE = "Diptych IDs";

describe("HttpMetadataFetcher", () => {
    it("preserves every attribute in captured Cambria metadata with multiple values for one key", async () => {
        // Public tokenURI metadata captured on 2026-10-17. Affinity is multivalued.
        const metadata = await new HttpMetadataFetcher().fetchMetadata(
            buildMetadataDataUri(cambriaMetadata),
        );
        expect(metadata?.attributes).toHaveLength(12);
        expect(
            metadata?.attributes
                .filter((attribute) => attribute.traitType === "Affinity")
                .map((attribute) => attribute.value),
        ).toEqual(["Pugilist", "Prospector", "Delver", "Forager"]);
        expect(metadata?.attributes).toContainEqual({
            traitType: "Affinities",
            displayType: undefined,
            value: "4",
        });
        expect(metadata?.attributes).toContainEqual({
            traitType: "Top Affinity Score",
            displayType: "number",
            value: 98,
        });
    });

    it("keeps multivalued explicit attributes ahead of fallback containers", async () => {
        const metadata = await new HttpMetadataFetcher().fetchMetadata(
            buildMetadataDataUri({
                [TOKEN_METADATA_ATTRIBUTE_CONTAINER_FIELD.Attributes]:
                    cambriaMetadata.attributes,
                [TOKEN_METADATA_ATTRIBUTE_CONTAINER_FIELD.Features]: {
                    Palette: "Blue",
                },
            }),
        );
        expect(metadata?.attributes).toHaveLength(
            cambriaMetadata.attributes.length,
        );
        expect(
            metadata?.attributes.some(
                (attribute) => attribute.traitType === "Palette",
            ),
        ).toBe(false);
    });

    it("uses multivalued traits when no usable features map is available", async () => {
        for (const features of [undefined, {}, { ignored: null }]) {
            const metadata = await new HttpMetadataFetcher().fetchMetadata(
                buildMetadataDataUri({
                    [TOKEN_METADATA_ATTRIBUTE_CONTAINER_FIELD.Traits]:
                        cambriaMetadata.attributes,
                    [TOKEN_METADATA_ATTRIBUTE_CONTAINER_FIELD.Features]:
                        features,
                }),
            );
            expect(metadata?.attributes).toHaveLength(
                cambriaMetadata.attributes.length,
            );
        }
    });

    it("still rejects repeated names in unrecognized heuristic containers", async () => {
        const metadata = await new HttpMetadataFetcher().fetchMetadata(
            buildMetadataDataUri({
                [TEST_EXPLICIT_TRAIT_CONTAINER_FIELD]:
                    cambriaMetadata.attributes,
            }),
        );
        expect(metadata?.attributes).toEqual([]);
    });

    it("uses generator_url as the animation fallback", async () => {
        const generatorUrl = "https://generator.example/token/1";
        const uri = buildMetadataDataUri({
            [TOKEN_METADATA_ANIMATION_SOURCE_FIELD.GeneratorUrl]: generatorUrl,
        });
        const fetcher = new HttpMetadataFetcher();

        const metadata = await fetcher.fetchMetadata(uri);

        expect(metadata?.animationUrl).toBe(generatorUrl);
    });

    it("uses requested bootstrap animation source field for canonical animation", async () => {
        const generatorUrl = "https://generator.example/token/1";
        const uri = buildMetadataDataUri({
            [TOKEN_METADATA_ANIMATION_SOURCE_FIELD.AnimationUrl]:
                "https://example.com/animation.html",
            [TOKEN_METADATA_ANIMATION_SOURCE_FIELD.GeneratorUrl]: generatorUrl,
        });
        const fetcher = new HttpMetadataFetcher();

        const metadata = await fetcher.fetchMetadata(uri, {
            animationSourceField:
                TOKEN_METADATA_ANIMATION_SOURCE_FIELD.GeneratorUrl,
        });

        expect(metadata?.animationUrl).toBe(generatorUrl);
    });

    it("omits animation_url when bootstrap animation source capture is disabled", async () => {
        const uri = buildMetadataDataUri({
            [TOKEN_METADATA_ANIMATION_SOURCE_FIELD.AnimationUrl]:
                "https://example.com/animation.html",
        });
        const fetcher = new HttpMetadataFetcher();

        const metadata = await fetcher.fetchMetadata(uri, {
            animationSourceField: null,
        });

        expect(metadata?.animationUrl).toBeUndefined();
    });

    it("uses requested bootstrap image source field for canonical image", async () => {
        const imageData = "data:image/svg+xml;base64,PHN2Zy8+";
        const uri = buildMetadataDataUri({
            [TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image]:
                "https://example.com/preview.png",
            [TOKEN_METADATA_IMAGE_SOURCE_FIELD.SvgImageData]: imageData,
        });
        const fetcher = new HttpMetadataFetcher();

        const metadata = await fetcher.fetchMetadata(uri, {
            imageSourceField: TOKEN_METADATA_IMAGE_SOURCE_FIELD.SvgImageData,
        });

        expect(metadata?.image).toBe(imageData);
    });

    it("uses traits as the explicit fallback attribute container", async () => {
        const uri = buildMetadataDataUri({
            [TOKEN_METADATA_ATTRIBUTE_CONTAINER_FIELD.Traits]: [
                {
                    [TOKEN_METADATA_ATTRIBUTE_ITEM_FIELD.TraitType]:
                        "Metropolis",
                    [TOKEN_METADATA_ATTRIBUTE_ITEM_FIELD.Value]:
                        "Palette: Vermeer",
                },
            ],
        });
        const fetcher = new HttpMetadataFetcher();

        const metadata = await fetcher.fetchMetadata(uri);

        expect(metadata?.attributes).toEqual([
            {
                traitType: "Metropolis",
                displayType: undefined,
                value: "Palette: Vermeer",
            },
        ]);
    });

    it("uses features object traits when fallback traits repeat the same key", async () => {
        const uri = buildMetadataDataUri({
            [TOKEN_METADATA_ATTRIBUTE_CONTAINER_FIELD.Traits]: [
                {
                    [TOKEN_METADATA_ATTRIBUTE_ITEM_FIELD.TraitType]:
                        "Metropolis",
                    [TOKEN_METADATA_ATTRIBUTE_ITEM_FIELD.Value]: "City: Berlin",
                },
                {
                    [TOKEN_METADATA_ATTRIBUTE_ITEM_FIELD.TraitType]:
                        "Metropolis",
                    [TOKEN_METADATA_ATTRIBUTE_ITEM_FIELD.Value]: "Paper: White",
                },
            ],
            [TOKEN_METADATA_ATTRIBUTE_CONTAINER_FIELD.Features]: {
                City: "Berlin",
                Paper: "White",
                Signed: "No",
                Palette: "Mariposa",
                [TEST_FEATURE_ATTRIBUTE_KEY_WITH_SPACE]: "Oil",
                [TEST_FEATURE_ATTRIBUTE_KEY_WITH_PIPE]: "100 | 647",
            },
        });
        const fetcher = new HttpMetadataFetcher();

        const metadata = await fetcher.fetchMetadata(uri);

        expect(metadata?.attributes).toEqual([
            {
                traitType: "City",
                displayType: undefined,
                value: "Berlin",
            },
            {
                traitType: "Paper",
                displayType: undefined,
                value: "White",
            },
            {
                traitType: "Signed",
                displayType: undefined,
                value: "No",
            },
            {
                traitType: "Palette",
                displayType: undefined,
                value: "Mariposa",
            },
            {
                traitType: TEST_FEATURE_ATTRIBUTE_KEY_WITH_SPACE,
                displayType: undefined,
                value: "Oil",
            },
            {
                traitType: TEST_FEATURE_ATTRIBUTE_KEY_WITH_PIPE,
                displayType: undefined,
                value: "100 | 647",
            },
        ]);
    });

    it("uses a simple trait-like key/value container as the last-resort fallback", async () => {
        const uri = buildMetadataDataUri({
            [TEST_HEURISTIC_ATTRIBUTE_CONTAINER_FIELD]: [
                {
                    [TOKEN_METADATA_ATTRIBUTE_ITEM_FIELD.Key]: "Palette",
                    [TOKEN_METADATA_ATTRIBUTE_ITEM_FIELD.Value]: "Vermeer",
                },
            ],
        });
        const fetcher = new HttpMetadataFetcher();

        const metadata = await fetcher.fetchMetadata(uri);

        expect(metadata?.attributes).toEqual([
            {
                traitType: "Palette",
                displayType: undefined,
                value: "Vermeer",
            },
        ]);
    });

    it("uses explicit trait/value pairs from an arbitrary top-level container", async () => {
        const uri = buildMetadataDataUri({
            [TEST_EXPLICIT_TRAIT_CONTAINER_FIELD]: [
                {
                    [TOKEN_METADATA_ATTRIBUTE_ITEM_FIELD.Trait]: "Brush Style",
                    [TOKEN_METADATA_ATTRIBUTE_ITEM_FIELD.Value]: "Oil",
                },
            ],
        });
        const fetcher = new HttpMetadataFetcher();

        const metadata = await fetcher.fetchMetadata(uri);

        expect(metadata?.attributes).toEqual([
            {
                traitType: "Brush Style",
                displayType: undefined,
                value: "Oil",
            },
        ]);
    });
});

function buildMetadataDataUri(metadata: Record<string, unknown>): string {
    return `data:application/json,${encodeURIComponent(JSON.stringify(metadata))}`;
}
