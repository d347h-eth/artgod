import { describe, expect, it } from "vitest";
import {
    TOKEN_METADATA_ANIMATION_SOURCE_FIELD,
    selectTokenMetadataAnimationSource,
} from "./token-metadata-animation-source.js";

describe("token metadata animation source selection", () => {
    it("uses animation_url before generator_url", () => {
        const selected = selectTokenMetadataAnimationSource({
            [TOKEN_METADATA_ANIMATION_SOURCE_FIELD.AnimationUrl]:
                "ipfs://QmAnimation",
            [TOKEN_METADATA_ANIMATION_SOURCE_FIELD.GeneratorUrl]:
                "https://generator.example/token/1",
        });

        expect(selected).toBe("ipfs://QmAnimation");
    });

    it("falls back to generator_url when animation_url is absent", () => {
        const selected = selectTokenMetadataAnimationSource({
            [TOKEN_METADATA_ANIMATION_SOURCE_FIELD.GeneratorUrl]:
                "https://generator.example/token/1",
        });

        expect(selected).toBe("https://generator.example/token/1");
    });

    it("skips blank animation_url values before generator_url", () => {
        const selected = selectTokenMetadataAnimationSource({
            [TOKEN_METADATA_ANIMATION_SOURCE_FIELD.AnimationUrl]: " ",
            [TOKEN_METADATA_ANIMATION_SOURCE_FIELD.GeneratorUrl]:
                "https://generator.example/token/1",
        });

        expect(selected).toBe("https://generator.example/token/1");
    });
});
