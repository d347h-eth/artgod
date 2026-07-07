import { describe, expect, it } from "vitest";
import {
    IMAGE_CACHE_MODE,
    defaultImageCachePolicyConfig,
    type ImageCachePolicyConfig,
} from "@artgod/shared/media/token-image-cache";
import { TOKEN_METADATA_IMAGE_SOURCE_FIELD } from "@artgod/shared/media/token-metadata-image-source";
import { EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND } from "@artgod/shared/extensions";
import { BOOTSTRAP_ENUMERATION_MODE } from "@artgod/shared/bootstrap/pipeline";
import { COLLECTION_CUSTOMIZATION_SOURCE_KIND } from "@artgod/shared/types";
import {
    BOOTSTRAP_PROBE_FIRST_TOKEN_SOURCE,
    BOOTSTRAP_PROBE_IMAGE_BYTES_SOURCE,
    BOOTSTRAP_PROBE_READ_STATUS,
    BOOTSTRAP_PROBE_TOKEN_CANDIDATE_SOURCE,
    ProbeCollectionContractUseCase,
    type CollectionContractProbePort,
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
                status: BOOTSTRAP_PROBE_READ_STATUS.Available,
                value: "3",
                safeIntegerValue: 3,
                bootstrapRangeValue: 3,
                error: null,
            },
            firstToken: {
                tokenId: "1",
                source: BOOTSTRAP_PROBE_FIRST_TOKEN_SOURCE.TokenByIndex,
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
                status: BOOTSTRAP_PROBE_READ_STATUS.Available,
                value: "999",
                safeIntegerValue: 999,
                bootstrapRangeValue: 999,
                error: null,
            },
            firstToken: {
                tokenId: "0",
                source: BOOTSTRAP_PROBE_FIRST_TOKEN_SOURCE.CandidateTokenUri,
                tokenUri: "data:application/json,%7B%7D",
                tokenUriPayloadBytes: 10,
                tokenUriPayloadTruncated: false,
                tokenUriPayloadError: null,
                name: null,
                imageSourceField: TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image,
                image: null,
                imageBytes: 2048,
                imageBytesSource: BOOTSTRAP_PROBE_IMAGE_BYTES_SOURCE.Download,
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
                        source: BOOTSTRAP_PROBE_TOKEN_CANDIDATE_SOURCE.TokenUri,
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
                mode: BOOTSTRAP_ENUMERATION_MODE.ManualRange,
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
                    status: BOOTSTRAP_PROBE_READ_STATUS.Available,
                    value: "3",
                    safeIntegerValue: 3,
                    bootstrapRangeValue: 3,
                    error: null,
                },
                firstToken: {
                    tokenId: "1",
                    source: BOOTSTRAP_PROBE_FIRST_TOKEN_SOURCE.TokenByIndex,
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

    it("forwards a trimmed custom sample token id to the contract probe", async () => {
        const probeInputs: Array<{
            sampleTokenId: string | null;
        }> = [];
        const useCase = makeUseCase(
            {
                enumerable: {
                    supported: true,
                    error: null,
                },
                totalSupply: {
                    status: BOOTSTRAP_PROBE_READ_STATUS.Available,
                    value: "3",
                    safeIntegerValue: 3,
                    bootstrapRangeValue: 3,
                    error: null,
                },
            },
            undefined,
            (input) => {
                probeInputs.push({
                    sampleTokenId: input.sampleTokenId,
                });
            },
        );

        await useCase.probe({
            chainRef: "ethereum",
            address: "0x3333333333333333333333333333333333333333",
            standard: "erc721",
            sampleTokenId: "  token-42  ",
        });

        expect(probeInputs).toEqual([
            {
                sampleTokenId: "token-42",
            },
        ]);
    });

    it("does not infer collection scope from a custom sample token id", async () => {
        const useCase = makeUseCase({
            enumerable: {
                supported: false,
                error: null,
            },
            totalSupply: {
                status: BOOTSTRAP_PROBE_READ_STATUS.Available,
                value: "999",
                safeIntegerValue: 999,
                bootstrapRangeValue: 999,
                error: null,
            },
            firstToken: {
                tokenId: "42",
                source: BOOTSTRAP_PROBE_FIRST_TOKEN_SOURCE.CandidateTokenUri,
                tokenUri: "data:application/json,%7B%7D",
                tokenUriPayloadBytes: 10,
                tokenUriPayloadTruncated: false,
                tokenUriPayloadError: null,
                name: null,
                imageSourceField: TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image,
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
            address: "0x3333333333333333333333333333333333333333",
            standard: "erc721",
            sampleTokenId: "42",
        });

        expect(result.suggestedInput).toEqual({
            supportsEnumerable: false,
            manualInput: null,
            ready: false,
            warnings: [],
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
    onProbeInput: (
        input: Parameters<
            CollectionContractProbePort["probeErc721Contract"]
        >[0],
    ) => void = () => {},
) {
    const probe: CollectionContractProbeResult = {
        proxy: null,
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
            status: BOOTSTRAP_PROBE_READ_STATUS.Unavailable,
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
            async probeErc721Contract(input) {
                onProbeInput(input);
                return probe;
            },
        },
        extensionResolver,
    );
}
