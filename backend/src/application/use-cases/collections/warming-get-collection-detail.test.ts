import { describe, expect, it, vi } from "vitest";
import type {
    GetCollectionDetailInput,
    GetCollectionDetailOutput,
} from "./get-collection-detail.js";
import { WarmingGetCollectionDetail } from "./warming-get-collection-detail.js";

describe("WarmingGetCollectionDetail", () => {
    it("warms preview entries for the default listed first page", () => {
        const output = createOutput();
        const inner = {
            getCollectionDetail: vi.fn(() => output),
        };
        const warmup = {
            warmTokenPreviews: vi.fn(),
        };
        const warming = new WarmingGetCollectionDetail(inner, warmup);

        expect(warming.getCollectionDetail(createInput())).toBe(output);
        expect(warmup.warmTokenPreviews).toHaveBeenCalledWith({
            chainRef: "ethereum",
            collectionRef: "terraforms",
            mediaMode: "artifact",
            tokenRefs: ["7710", "7711"],
        });
    });

    it("skips warmup for non-default collection detail queries", () => {
        const inner = {
            getCollectionDetail: vi.fn(() => createOutput()),
        };
        const warmup = {
            warmTokenPreviews: vi.fn(),
        };
        const warming = new WarmingGetCollectionDetail(inner, warmup);

        warming.getCollectionDetail({
            ...createInput(),
            mediaMode: "snapshot",
        });

        expect(warmup.warmTokenPreviews).not.toHaveBeenCalled();
    });
});

function createInput(
    overrides: Partial<GetCollectionDetailInput> = {},
): GetCollectionDetailInput {
    return {
        chainRef: "ethereum",
        collectionRef: "terraforms",
        tokenStatus: "listed",
        limit: 250,
        traits: [],
        traitRanges: [],
        ...overrides,
    };
}

function createOutput(): GetCollectionDetailOutput {
    return {
        chain: {
            id: 1,
            type: "evm",
            publicChainId: 1,
            slug: "ethereum",
            name: "Ethereum",
        },
        collection: {
            chainId: 1,
            collectionId: 2,
            slug: "terraforms",
            address: "0x2222222222222222222222222222222222222222",
            standard: "erc721",
            status: "live",
            deploymentBlock: null,
            bootstrapAnchorBlock: null,
            createdAt: "2025-01-01T00:00:00.000Z",
            updatedAt: "2025-01-01T00:00:00.000Z",
        },
        traits: {
            selected: [],
            selectedRanges: [],
            facets: [],
        },
        media: {
            selectedMode: "artifact",
            defaultMode: "artifact",
            availableModes: [
                { key: "artifact", label: "artifact" },
                { key: "snapshot", label: "snapshot" },
            ],
        },
        tokens: {
            items: [
                {
                    tokenId: "7710",
                    name: "Terraforms #7710",
                    image: "https://example.com/7710.png",
                    traitSummary: null,
                    listingPrice: "1000000000000000000",
                    listingCurrency: "0x0000000000000000000000000000000000000000",
                    attributes: [],
                    hasMetadata: true,
                    metadataUpdatedAt: "2026-01-01T00:00:00.000Z",
                },
                {
                    tokenId: "7711",
                    name: "Terraforms #7711",
                    image: "https://example.com/7711.png",
                    traitSummary: null,
                    listingPrice: "1000000000000000000",
                    listingCurrency: "0x0000000000000000000000000000000000000000",
                    attributes: [],
                    hasMetadata: true,
                    metadataUpdatedAt: "2026-01-01T00:00:00.000Z",
                },
            ],
            prevCursor: null,
            nextCursor: null,
            limit: 250,
            totalItems: 2,
            rangeStart: 1,
            rangeEnd: 2,
            currentPage: 1,
            totalPages: 1,
        },
    };
}
