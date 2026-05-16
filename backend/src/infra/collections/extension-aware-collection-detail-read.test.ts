import { describe, expect, it } from "vitest";
import type { ApmPort, SpanAttributes } from "@artgod/shared/observability/apm";
import { TERRAFORMS_EXTENSION_KEY } from "@artgod/shared/extensions/terraforms";
import type {
    CollectionListItem,
    TokenCard,
    TokenBrowserStatus,
    TraitFacet,
} from "@artgod/shared/types";
import { ExtensionAwareCollectionDetailRead } from "./extension-aware-collection-detail-read.js";

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

describe("ExtensionAwareCollectionDetailRead observability", () => {
    it("wraps extension-defined activity feed presentation in child spans", () => {
        const apm = new CapturingApm();
        const readModel = new ExtensionAwareCollectionDetailRead(
            createBaseReadPort(),
            {
                getInstallByCollectionId() {
                    return {
                        chainId: 1,
                        collectionId: 7,
                        extensionKey: TERRAFORMS_EXTENSION_KEY,
                        enabled: true,
                        configJson: "{}",
                        createdAt: "2026-01-01T00:00:00Z",
                        updatedAt: "2026-01-01T00:00:00Z",
                    };
                },
                getArtifact() {
                    return null;
                },
                listTokenCardArtifactsByTokenIds() {
                    return new Map();
                },
            },
            apm,
        );

        const collection = readModel.resolveCollectionRef(1, "terraforms");

        expect(collection.extensions).toEqual([
            { key: TERRAFORMS_EXTENSION_KEY },
        ]);
        expect(collection.activityEventFeeds).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    extensionKey: TERRAFORMS_EXTENSION_KEY,
                    eventKey: "terraformed",
                }),
            ]),
        );
        expect(apm.spans).toEqual([
            {
                name: "backend.extension.install_lookup",
                attributes: {
                    "artgod.chain_id": 1,
                    "artgod.collection_id": 7,
                },
            },
            {
                name: "backend.extension.resolve",
                attributes: {
                    "artgod.chain_id": 1,
                    "artgod.collection_id": 7,
                    "artgod.extension.key": TERRAFORMS_EXTENSION_KEY,
                },
            },
            {
                name: "backend.extension.activity_event_feeds",
                attributes: {
                    "artgod.chain_id": 1,
                    "artgod.collection_id": 7,
                    "artgod.extension.key": TERRAFORMS_EXTENSION_KEY,
                },
            },
        ]);
    });

    it("batches extension artifacts when resolving token cards", () => {
        const apm = new CapturingApm();
        const requestedTokenIds: string[][] = [];
        const readModel = new ExtensionAwareCollectionDetailRead(
            {
                ...createBaseReadPort(),
                listCollectionTokens() {
                    return {
                        items: [
                            tokenCard("1", "snapshot-1"),
                            tokenCard("2", "snapshot-2"),
                        ],
                        prevCursor: null,
                        nextCursor: null,
                        limit: 250,
                        totalItems: 2,
                        rangeStart: 1,
                        rangeEnd: 2,
                        currentPage: 1,
                        totalPages: 1,
                    };
                },
            },
            {
                ...createExtensionRecords(),
                listTokenCardArtifactsByTokenIds(params) {
                    requestedTokenIds.push(params.tokenIds);
                    return new Map([
                        [
                            "1",
                            {
                                extensionKey: TERRAFORMS_EXTENSION_KEY,
                                artifactRef: params.artifactRef,
                                image: "artifact-1",
                                animationUrl: null,
                                htmlContent: null,
                            },
                        ],
                    ]);
                },
            },
            apm,
        );

        const page = readModel.listCollectionTokens({
            chainId: 1,
            collectionId: 7,
            tokenStatus: "listed",
            limit: 250,
        });

        expect(requestedTokenIds).toEqual([["1", "2"]]);
        expect(page.items.map((token) => token.image)).toEqual([
            "artifact-1",
            "snapshot-2",
        ]);
        expect(apm.spans).toContainEqual({
            name: "backend.extension.artifacts_batch",
            attributes: expect.objectContaining({
                "artgod.chain_id": 1,
                "artgod.collection_id": 7,
                "artgod.extension.key": TERRAFORMS_EXTENSION_KEY,
                "artgod.tokens.count": 2,
            }),
        });
    });

    it("passes caller range-only trait facets before reading stats", () => {
        let receivedRangeOnlyKeys: string[] | undefined;
        const readModel = new ExtensionAwareCollectionDetailRead(
            {
                ...createBaseReadPort(),
                listCollectionTraitFacets(
                    _chainId: number,
                    _collectionId: number,
                    _owner?: string,
                    options?: { rangeOnlyKeys?: string[] },
                ): TraitFacet[] {
                    receivedRangeOnlyKeys = options?.rangeOnlyKeys;
                    return [];
                },
            },
            createExtensionRecords(),
        );

        readModel.listCollectionTraitFacets(1, 7, undefined, {
            rangeOnlyKeys: ["Power"],
        });

        expect(receivedRangeOnlyKeys).toEqual(["Power"]);
    });
});

function createExtensionRecords() {
    return {
        getInstallByCollectionId() {
            return {
                chainId: 1,
                collectionId: 7,
                extensionKey: TERRAFORMS_EXTENSION_KEY,
                enabled: true,
                configJson: "{}",
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:00Z",
            };
        },
        getArtifact() {
            return null;
        },
        listTokenCardArtifactsByTokenIds() {
            return new Map();
        },
    };
}

function tokenCard(tokenId: string, image: string): TokenCard {
    return {
        tokenId,
        name: null,
        image,
        traitSummary: null,
        hasMetadata: true,
        metadataUpdatedAt: "2026-01-01T00:00:00Z",
        listingPrice: null,
        listingCurrency: null,
        attributes: [],
    };
}

function createBaseReadPort() {
    const collection: CollectionListItem = {
        chainId: 1,
        collectionId: 7,
        slug: "terraforms",
        address: "0x4e1f41613c9084fdb9e34e11fae9412427480e56",
        standard: "erc721",
        status: "live",
        deploymentBlock: 12_345,
        bootstrapAnchorBlock: 12_345,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
    };

    return {
        resolveCollectionRef() {
            return collection;
        },
        listCollectionTokens(_params: { tokenStatus: TokenBrowserStatus }) {
            throw new Error("Unexpected listCollectionTokens call");
        },
        listCollectionTraitFacets() {
            throw new Error("Unexpected listCollectionTraitFacets call");
        },
        listCollectionHolders() {
            throw new Error("Unexpected listCollectionHolders call");
        },
        getCollectionTokenDetail() {
            throw new Error("Unexpected getCollectionTokenDetail call");
        },
        getCollectionTokenPreview() {
            throw new Error("Unexpected getCollectionTokenPreview call");
        },
        listCollectionTokenCardsByIds() {
            throw new Error("Unexpected listCollectionTokenCardsByIds call");
        },
    };
}
