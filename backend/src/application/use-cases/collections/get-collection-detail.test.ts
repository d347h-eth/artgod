import { describe, expect, it } from "vitest";
import type { ApmPort, SpanAttributes } from "@artgod/shared/observability/apm";
import { TRAIT_FILTER_DISPLAY_KIND } from "@artgod/shared/types";
import type {
    ChainRecord,
    CollectionListItem,
    CollectionMediaState,
    TokenCursorPage,
    TraitFacet,
} from "@artgod/shared/types/browse";
import { GetCollectionDetailUseCase } from "./get-collection-detail.js";

class CapturingApm implements ApmPort {
    readonly spans: Array<{ name: string; attributes: SpanAttributes }> = [];

    async withSpan<T>(
        name: string,
        attributes: SpanAttributes,
        run: () => Promise<T>,
    ): Promise<T> {
        this.spans.push({ name, attributes });
        return run();
    }

    withSyncSpan<T>(name: string, attributes: SpanAttributes, run: () => T): T {
        this.spans.push({ name, attributes });
        return run();
    }
}

describe("GetCollectionDetailUseCase observability", () => {
    it("wraps collection-detail phases and uses effective range keys for facet reads", () => {
        const apm = new CapturingApm();
        let receivedRangeOnlyKeys: string[] | undefined;
        const useCase = new GetCollectionDetailUseCase(
            1,
            {
                resolveChainRef: () => chain(),
            },
            {
                resolveCollectionRef: () => collection(),
                getCollectionMediaState: () => mediaState(),
                listCollectionTokens: () => tokenPage(),
                listCollectionTraitFacets: (
                    _chainId,
                    _collectionId,
                    _owner,
                    options,
                ) => {
                    receivedRangeOnlyKeys = options?.rangeOnlyKeys;
                    return [traitFacet("Power")];
                },
            },
            {
                getTraitFilterPresentationState: () => {
                    return {
                        effectiveConfig: {
                            rangeKeys: ["Power"],
                        },
                    };
                },
                getTokenCardTraitSummaryTemplateState: () => ({
                    effectiveConfig: {
                        template: "{Power}",
                    },
                }),
            },
            apm,
        );

        const output = useCase.getCollectionDetail({
            chainRef: "ethereum",
            collectionRef: "terraforms",
            tokenStatus: "listed",
            limit: 50,
            traits: [],
            traitRanges: [],
        });

        expect(receivedRangeOnlyKeys).toEqual(["Power"]);
        expect(output.tokens.items[0]?.traitSummary).toBe("7");
        expect(apm.spans.map((span) => span.name)).toEqual([
            "backend.collection_detail.chain",
            "backend.collection_detail.collection",
            "backend.collection_detail.media_state",
            "backend.collection_detail.tokens",
            "backend.collection_detail.trait_filter_presentation",
            "backend.collection_detail.trait_facets",
            "backend.collection_detail.token_summary_template",
            "backend.collection_detail.token_summary_render",
        ]);
        expect(apm.spans).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    name: "backend.collection_detail.tokens",
                    attributes: expect.objectContaining({
                        "artgod.chain_id": 1,
                        "artgod.collection_id": 7,
                        "artgod.collection.token_status": "listed",
                        "artgod.collection.limit": 50,
                    }),
                }),
                expect.objectContaining({
                    name: "backend.collection_detail.trait_facets",
                    attributes: expect.objectContaining({
                        "artgod.collection.range_only_keys_count": 1,
                    }),
                }),
            ]),
        );
    });
});

function chain(): ChainRecord {
    return {
        id: 1,
        type: "evm",
        publicChainId: 1,
        slug: "ethereum",
        name: "Ethereum",
    };
}

function collection(): CollectionListItem {
    return {
        chainId: 1,
        collectionId: 7,
        slug: "terraforms",
        address: "0x0000000000000000000000000000000000000001",
        standard: "erc721",
        status: "live",
        deploymentBlock: 1,
        bootstrapAnchorBlock: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
    };
}

function mediaState(): CollectionMediaState {
    return {
        selectedMode: "snapshot",
        defaultMode: "snapshot",
        availableModes: [],
    };
}

function tokenPage(): TokenCursorPage {
    return {
        items: [
            {
                tokenId: "1",
                name: "Token 1",
                image: null,
                listingPrice: null,
                listingCurrency: null,
                attributes: [{ key: "Power", value: "7" }],
                traitSummary: null,
                hasMetadata: true,
                metadataUpdatedAt: "2026-01-01T00:00:00.000Z",
            },
        ],
        nextCursor: null,
        prevCursor: null,
        limit: 50,
        totalItems: 1,
        rangeStart: 1,
        rangeEnd: 1,
        currentPage: 1,
        totalPages: 1,
    };
}

function traitFacet(key: string): TraitFacet {
    return {
        key,
        displayKind: TRAIT_FILTER_DISPLAY_KIND.Set,
        minValue: null,
        maxValue: null,
        values: [{ value: "Beanie", tokenCount: 1 }],
    };
}
