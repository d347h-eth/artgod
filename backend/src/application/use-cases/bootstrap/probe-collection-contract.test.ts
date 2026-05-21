import { describe, expect, it } from "vitest";
import { ProbeCollectionContractUseCase } from "./probe-collection-contract.js";
import type { CollectionContractProbeResult } from "./probe-collection-contract.js";

const CHAIN = {
    id: 1,
    type: "evm",
    publicChainId: 1,
    slug: "ethereum",
    name: "Ethereum",
};

describe("ProbeCollectionContractUseCase", () => {
    it("marks enumerable contracts ready without manual input", async () => {
        const useCase = makeUseCase({
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
                image: null,
                imageBytes: null,
                imageBytesSource: null,
                imageContentType: null,
                imageBytesError: null,
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
                image: null,
                imageBytes: 2048,
                imageBytesSource: "download",
                imageContentType: "image/png",
                imageBytesError: null,
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
});

function makeUseCase(overrides: Partial<CollectionContractProbeResult>) {
    const probe: CollectionContractProbeResult = {
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
            image: null,
            imageBytes: null,
            imageBytesSource: null,
            imageContentType: null,
            imageBytesError: null,
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
    );
}
