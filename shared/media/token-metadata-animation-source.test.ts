import { describe, expect, it } from "vitest";
import {
    TOKEN_METADATA_ANIMATION_SOURCE_FIELD,
    selectTokenMetadataAnimationSource,
} from "./token-metadata-animation-source.js";

describe("token metadata animation source selection", () => {
    it("uses animation_url before generator_url", () => {
        const selected = selectTokenMetadataAnimationSource({
            metadata: {
                [TOKEN_METADATA_ANIMATION_SOURCE_FIELD.AnimationUrl]:
                    "ipfs://QmAnimation",
                [TOKEN_METADATA_ANIMATION_SOURCE_FIELD.GeneratorUrl]:
                    "https://generator.example/token/1",
            },
        });

        expect(selected).toEqual({
            field: TOKEN_METADATA_ANIMATION_SOURCE_FIELD.AnimationUrl,
            value: "ipfs://QmAnimation",
        });
    });

    it("falls back to generator_url when animation_url is absent", () => {
        const selected = selectTokenMetadataAnimationSource({
            metadata: {
                [TOKEN_METADATA_ANIMATION_SOURCE_FIELD.GeneratorUrl]:
                    "https://generator.example/token/1",
            },
        });

        expect(selected).toEqual({
            field: TOKEN_METADATA_ANIMATION_SOURCE_FIELD.GeneratorUrl,
            value: "https://generator.example/token/1",
        });
    });

    it("skips blank animation_url values before generator_url", () => {
        const selected = selectTokenMetadataAnimationSource({
            metadata: {
                [TOKEN_METADATA_ANIMATION_SOURCE_FIELD.AnimationUrl]: " ",
                [TOKEN_METADATA_ANIMATION_SOURCE_FIELD.GeneratorUrl]:
                    "https://generator.example/token/1",
            },
        });

        expect(selected).toEqual({
            field: TOKEN_METADATA_ANIMATION_SOURCE_FIELD.GeneratorUrl,
            value: "https://generator.example/token/1",
        });
    });

    it("uses a requested animation source field without falling back", () => {
        const selected = selectTokenMetadataAnimationSource({
            metadata: {
                [TOKEN_METADATA_ANIMATION_SOURCE_FIELD.AnimationUrl]:
                    "https://example.com/animation.html",
                [TOKEN_METADATA_ANIMATION_SOURCE_FIELD.GeneratorUrl]:
                    "https://generator.example/token/1",
            },
            requestedField: TOKEN_METADATA_ANIMATION_SOURCE_FIELD.GeneratorUrl,
        });

        expect(selected).toEqual({
            field: TOKEN_METADATA_ANIMATION_SOURCE_FIELD.GeneratorUrl,
            value: "https://generator.example/token/1",
        });
    });

    it("rejects requested animation fields that do not resolve to media URIs", () => {
        const selected = selectTokenMetadataAnimationSource({
            metadata: {
                [TOKEN_METADATA_ANIMATION_SOURCE_FIELD.AnimationUrl]: "not a uri",
                [TOKEN_METADATA_ANIMATION_SOURCE_FIELD.GeneratorUrl]:
                    "https://generator.example/token/1",
            },
            requestedField: TOKEN_METADATA_ANIMATION_SOURCE_FIELD.AnimationUrl,
        });

        expect(selected).toBeNull();
    });
});
