import { describe, expect, it } from "vitest";
import { ARTGOD_SPAN_ATTRIBUTE } from "@artgod/shared/observability";
import type { ApmPort, SpanAttributes } from "@artgod/shared/observability/apm";
import type {
    ChainRecord,
    CollectionListItem,
    TraitCatalogFacet,
} from "@artgod/shared/types/browse";
import { GetCollectionTraitCatalogUseCase } from "./get-collection-trait-catalog.js";

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

describe("GetCollectionTraitCatalogUseCase", () => {
    it("loads requested trait counts within the caller's trait scope", () => {
        const apm = new CapturingApm();
        let receivedKeys: string[] | undefined;
        let receivedScope: unknown;
        const useCase = new GetCollectionTraitCatalogUseCase(
            1,
            {
                resolveChainRef: () => chain(),
            },
            {
                resolveCollectionRef: () => collection(),
                listCollectionTraitCatalog: (params): TraitCatalogFacet[] => {
                    receivedKeys = params.keys;
                    receivedScope = params.scopeTraitFilters;
                    return [{ key: "Zone", values: [] }];
                },
            },
            apm,
        );

        const output = useCase.getCollectionTraitCatalog({
            chainRef: "ethereum",
            collectionRef: "terraforms",
            keys: ["Zone"],
            scopeTraitFilters: [{ key: "Level", value: "14" }],
        });

        expect(receivedKeys).toEqual(["Zone"]);
        expect(receivedScope).toEqual([{ key: "Level", value: "14" }]);
        expect(output.traitCatalog).toEqual({
            scope: [{ key: "Level", value: "14" }],
            facets: [{ key: "Zone", values: [] }],
        });
        expect(apm.spans.map((span) => span.name)).toEqual([
            "backend.collection_trait_catalog.chain",
            "backend.collection_trait_catalog.collection",
            "backend.collection_trait_catalog.facets",
        ]);
        expect(apm.spans).toContainEqual(
            expect.objectContaining({
                name: "backend.collection_trait_catalog.facets",
                attributes: expect.objectContaining({
                    [ARTGOD_SPAN_ATTRIBUTE.CollectionTraitCatalogKeysCount]: 1,
                    [ARTGOD_SPAN_ATTRIBUTE.CollectionTraitFiltersCount]: 1,
                }),
            }),
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
