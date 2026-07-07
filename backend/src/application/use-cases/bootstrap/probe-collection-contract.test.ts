import { describe, expect, it } from "vitest";
import {
    IMAGE_CACHE_MODE,
    defaultImageCachePolicyConfig,
    type ImageCachePolicyConfig,
} from "@artgod/shared/media/token-image-cache";
import { TOKEN_METADATA_IMAGE_SOURCE_FIELD } from "@artgod/shared/media/token-metadata-image-source";
import { EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND } from "@artgod/shared/extensions";
import { COLLECTION_CUSTOMIZATION_SOURCE_KIND } from "@artgod/shared/types";
import {
    ProbeCollectionContractUseCase,
    type ProbeCollectionExtensionResolverPort,
} from "./probe-collection-contract.js";
import type { CollectionContractProbeResult } from "./probe-collection-contract.js";

const CHAIN = {
    id: 1,
    type: "evm",
    publicChainId: 1,
    slug: "ethereum",
    name: "Ethereum",
};

// Test extension key used to verify probe-time extension policy plumbing.
const PROBE_TEST_EXTENSION_KEY = "probe-test-extension";

describe("ProbeCollectionContractUseCase", () => {
    it("marks enumerable contracts ready without manual input", async () => {
        const useCase = makeUseCase({
            contractName: "Example Collection",
            enumerable: {
                supported: true,
                error: null,
            },
            totalSupply: {
                status: "available",
                value: "3",
                safeIntegerValue: 3,
                bootstrapRangeValue: 3,
                error: null,
            },
            firstToken: {
                tokenId: "1",
                source: "token_by_index",
                tokenUri: "data:application/json,%7B%7D",
                tokenUriPayloadBytes: 100,
                tokenUriPayloadTruncated: false,
                tokenUriPayloadError: null,
                name: null,
                imageSourceField: null,
                image: null,
                imageBytes: null,
                imageBytesSource: null,
                imageContentType: null,
                imageBytesError: null,
                imageWidth: null,
                imageHeight: null,
                animationSourceField: null,
                animationUrl: null,
                metadataError: null,
                candidates: [],
            },
        });

        const result = await useCase.probe({
            chainRef: "ethereum",
            address: "0x1111111111111111111111111111111111111111",
            standard: "erc721",
        });

        expect(result.contractName).toBe("Example Collection");
        expect(result.suggestedInput).toEqual({
            supportsEnumerable: true,
            manualInput: null,
            ready: true,
            warnings: [],
        });
        expect(result.storageEstimate).toEqual({
            sampleTokenId: "1",
            samplePayloadBytes: 100,
            projectedBytes: "300",
            totalSupply: "3",
        });
        expect(result.imageCacheSuggestion).toEqual({
            selectedSource: COLLECTION_CUSTOMIZATION_SOURCE_KIND.User,
            extensionKey: null,
            config: defaultImageCachePolicyConfig(),
        });
        expect(result.imageStorageEstimate).toBeNull();
    });

    it("infers manual range input for non-enumerable token id starts", async () => {
        const useCase = makeUseCase({
            enumerable: {
                supported: false,
                error: null,
            },
            totalSupply: {
                status: "available",
                value: "999",
                safeIntegerValue: 999,
                bootstrapRangeValue: 999,
                error: null,
            },
            firstToken: {
                tokenId: "0",
                source: "candidate_token_uri",
                tokenUri: "data:application/json,%7B%7D",
                tokenUriPayloadBytes: 10,
                tokenUriPayloadTruncated: false,
                tokenUriPayloadError: null,
                name: null,
                imageSourceField: TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image,
                image: null,
                imageBytes: 2048,
                imageBytesSource: "download",
                imageContentType: "image/png",
                imageBytesError: null,
                imageWidth: 1000,
                imageHeight: 1000,
                animationSourceField: null,
                animationUrl: null,
                metadataError: null,
                candidates: [
                    {
                        tokenId: "0",
                        exists: true,
                        source: "token_uri",
                        error: null,
                    },
                ],
            },
        });

        const result = await useCase.probe({
            chainRef: "ethereum",
            address: "0x2222222222222222222222222222222222222222",
            standard: "erc721",
        });

        expect(result.suggestedInput).toEqual({
            supportsEnumerable: false,
            manualInput: {
                mode: "manual_range",
                startTokenId: "0",
                totalSupply: 999,
            },
            ready: true,
            warnings: [],
        });
        expect(result.imageStorageEstimate).toEqual({
            sampleTokenId: "0",
            sampleImageBytes: 2048,
            projectedBytes: "2045952",
            totalSupply: "999",
            contentType: "image/png",
        });
    });

    it("uses embedded extension image cache policy suggestions when the probed scope matches", async () => {
        const extensionConfig: ImageCachePolicyConfig = {
            imageCacheMode: IMAGE_CACHE_MODE.Off,
            maxDimension: null,
        };
        const useCase = makeUseCase(
            {
                enumerable: {
                    supported: true,
                    error: null,
                },
                totalSupply: {
                    status: "available",
                    value: "3",
                    safeIntegerValue: 3,
                    bootstrapRangeValue: 3,
                    error: null,
                },
                firstToken: {
                    tokenId: "1",
                    source: "token_by_index",
                    tokenUri: "data:application/json,%7B%7D",
                    tokenUriPayloadBytes: 100,
                    tokenUriPayloadTruncated: false,
                    tokenUriPayloadError: null,
                    name: null,
                    imageSourceField: null,
                    image: null,
                    imageBytes: null,
                    imageBytesSource: null,
                    imageContentType: null,
                    imageBytesError: null,
                    imageWidth: null,
                    imageHeight: null,
                    animationSourceField: null,
                    animationUrl: null,
                    metadataError: null,
                    candidates: [],
                },
            },
            {
                resolveExtensionKey(input) {
                    expect(input.scope.kind).toBe(
                        EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.AllContractTokens,
                    );
                    return PROBE_TEST_EXTENSION_KEY;
                },
                resolveImageCachePolicyConfig(input) {
                    expect(input.extensionKey).toBe(PROBE_TEST_EXTENSION_KEY);
                    return extensionConfig;
                },
            },
        );

        const result = await useCase.probe({
            chainRef: "ethereum",
            address: "0x3333333333333333333333333333333333333333",
            standard: "erc721",
        });

        expect(result.imageCacheSuggestion).toEqual({
            selectedSource: COLLECTION_CUSTOMIZATION_SOURCE_KIND.Extension,
            extensionKey: PROBE_TEST_EXTENSION_KEY,
            config: extensionConfig,
        });
    });
});

function makeUseCase(
    overrides: Partial<CollectionContractProbeResult>,
    extensionResolver: ProbeCollectionExtensionResolverPort = {
        resolveExtensionKey() {
            return null;
        },
        resolveImageCachePolicyConfig() {
            return null;
        },
    },
) {
    const probe: CollectionContractProbeResult = {
        contractName: null,
        erc721: {
            supported: true,
            error: null,
        },
        enumerable: {
            supported: false,
            error: null,
        },
        totalSupply: {
            status: "unavailable",
            value: null,
            safeIntegerValue: null,
            bootstrapRangeValue: null,
            error: "missing",
        },
        firstToken: {
            tokenId: null,
            source: null,
            tokenUri: null,
            tokenUriPayloadBytes: null,
            tokenUriPayloadTruncated: false,
            tokenUriPayloadError: null,
            name: null,
            imageSourceField: null,
            image: null,
            imageBytes: null,
            imageBytesSource: null,
            imageContentType: null,
            imageBytesError: null,
            imageWidth: null,
            imageHeight: null,
            animationSourceField: null,
            animationUrl: null,
            metadataError: null,
            candidates: [],
        },
        ...overrides,
    };
    return new ProbeCollectionContractUseCase(
        1,
        {
            resolveChainRef() {
                return CHAIN;
            },
        },
        {
            async probeErc721Contract() {
                return probe;
            },
        },
        extensionResolver,
    );
}
