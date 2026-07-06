import { describe, expect, it } from "vitest";
import { ARTGOD_SPAN_ATTRIBUTE } from "@artgod/shared/observability";
import type { ApmPort, SpanAttributes } from "@artgod/shared/observability/apm";
import {
    TERRAFORMS_EXTENSION_KEY,
    TERRAFORMS_MAIN_READ_FUNCTIONS,
    TERRAFORMS_MEDIA_MODES,
} from "@artgod/shared/extensions/terraforms";
import type {
    CollectionListItem,
    TokenCard,
    TokenMediaPreview,
    TokenBrowserStatus,
    TraitCatalogFacet,
    TraitFacet,
} from "@artgod/shared/types";
import { ExtensionAwareCollectionDetailRead } from "./extension-aware-collection-detail-read.js";

const TERRAFORMS_MAIN_CONTRACT =
    "0x4e1f41613c9084fdb9e34e11fae9412427480e56";
const TERRAFORMS_RENDERER_V2_CONTRACT =
    "0x8af860c8f157f4e3b6a54913bfa6bb96ab2605c2";
const TERRAFORMS_TOKEN_URI_V2_CONTRACT =
    "0xfca647387e28e73e291dd90e7b09fa32bcbb2604";
const TERRAFORMS_BEACON_V2_CONTRACT =
    "0x331512a28a4cf80221af949b5d43041ff0fc7f01";

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
                    [ARTGOD_SPAN_ATTRIBUTE.ChainId]: 1,
                    [ARTGOD_SPAN_ATTRIBUTE.CollectionId]: 7,
                },
            },
            {
                name: "backend.extension.resolve",
                attributes: {
                    [ARTGOD_SPAN_ATTRIBUTE.ChainId]: 1,
                    [ARTGOD_SPAN_ATTRIBUTE.CollectionId]: 7,
                    [ARTGOD_SPAN_ATTRIBUTE.ExtensionKey]:
                        TERRAFORMS_EXTENSION_KEY,
                },
            },
            {
                name: "backend.extension.activity_event_feeds",
                attributes: {
                    [ARTGOD_SPAN_ATTRIBUTE.ChainId]: 1,
                    [ARTGOD_SPAN_ATTRIBUTE.CollectionId]: 7,
                    [ARTGOD_SPAN_ATTRIBUTE.ExtensionKey]:
                        TERRAFORMS_EXTENSION_KEY,
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
                        marketplaceBiddingSupportedTotalItems: 2,
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
                [ARTGOD_SPAN_ATTRIBUTE.ChainId]: 1,
                [ARTGOD_SPAN_ATTRIBUTE.CollectionId]: 7,
                [ARTGOD_SPAN_ATTRIBUTE.ExtensionKey]: TERRAFORMS_EXTENSION_KEY,
                [ARTGOD_SPAN_ATTRIBUTE.TokensCount]: 2,
            }),
        });
    });

    it("batches extension artifacts when resolving token cards by explicit ids", () => {
        const apm = new CapturingApm();
        const requestedTokenIds: string[][] = [];
        const readModel = new ExtensionAwareCollectionDetailRead(
            {
                ...createBaseReadPort(),
                listCollectionTokenCardsByIds(params) {
                    return params.tokenIds.map((tokenId) =>
                        tokenCard(tokenId, `snapshot-${tokenId}`),
                    );
                },
            },
            {
                ...createExtensionRecords(),
                getArtifact() {
                    throw new Error("Unexpected getArtifact call");
                },
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

        const tokens = readModel.listCollectionTokenCardsByIds({
            chainId: 1,
            collectionId: 7,
            tokenIds: ["1", "2"],
            includeListings: true,
        });

        expect(requestedTokenIds).toEqual([["1", "2"]]);
        expect(tokens.map((token) => token.image)).toEqual([
            "artifact-1",
            "snapshot-2",
        ]);
        expect(apm.spans).toContainEqual({
            name: "backend.extension.artifacts_batch",
            attributes: expect.objectContaining({
                [ARTGOD_SPAN_ATTRIBUTE.ChainId]: 1,
                [ARTGOD_SPAN_ATTRIBUTE.CollectionId]: 7,
                [ARTGOD_SPAN_ATTRIBUTE.ExtensionKey]: TERRAFORMS_EXTENSION_KEY,
                [ARTGOD_SPAN_ATTRIBUTE.TokensCount]: 2,
            }),
        });
    });

    it("keeps live collection cards on canonical media without artifact or RPC reads", () => {
        const readModel = new ExtensionAwareCollectionDetailRead(
            {
                ...createBaseReadPort(),
                listCollectionTokens() {
                    return {
                        items: [tokenCard("1", "canonical-1")],
                        prevCursor: null,
                        nextCursor: null,
                        limit: 250,
                        totalItems: 1,
                        marketplaceBiddingSupportedTotalItems: 1,
                        rangeStart: 1,
                        rangeEnd: 1,
                        currentPage: 1,
                        totalPages: 1,
                    };
                },
            },
            {
                ...createLiveExtensionRecords(),
                getArtifact() {
                    throw new Error("Unexpected token-card artifact read");
                },
                listTokenCardArtifactsByTokenIds() {
                    throw new Error("Unexpected token-card artifact batch");
                },
            },
            undefined,
            {
                async readContract() {
                    throw new Error("Unexpected token-card RPC read");
                },
                async getStorageAt() {
                    throw new Error("Unexpected token-card storage read");
                },
            },
        );

        const page = readModel.listCollectionTokens({
            chainId: 1,
            collectionId: 7,
            tokenStatus: "listed",
            limit: 250,
            mediaMode: TERRAFORMS_MEDIA_MODES.Live,
        });

        expect(page.items.map((token) => token.image)).toEqual(["canonical-1"]);
    });

    it("resolves live previews through the injected backend RPC client", async () => {
        const calls: Array<{ functionName: string; args?: readonly unknown[] }> =
            [];
        const readModel = new ExtensionAwareCollectionDetailRead(
            {
                ...createBaseReadPort(),
                getCollectionTokenPreview(): TokenMediaPreview {
                    return {
                        tokenId: "7710",
                        image: "canonical-image",
                        animationUrl: "snapshot-animation",
                    };
                },
            },
            createLiveExtensionRecords(),
            undefined,
            {
                async readContract<T = unknown>(params: {
                    functionName: string;
                    args?: readonly unknown[];
                }): Promise<T> {
                    calls.push({
                        functionName: params.functionName,
                        args: params.args,
                    });
                    return "<html>live</html>" as T;
                },
                async getStorageAt() {
                    throw new Error("Unexpected storage read");
                },
            },
        );

        const token = await readModel.getCollectionTokenPreview({
            chainId: 1,
            collectionId: 7,
            tokenId: "7710",
            mediaMode: TERRAFORMS_MEDIA_MODES.Live,
        });

        expect(calls).toEqual([
            {
                functionName: TERRAFORMS_MAIN_READ_FUNCTIONS.TokenHtml,
                args: [7710n],
            },
        ]);
        expect(token.image).toBe("canonical-image");
        expect(
            Buffer.from(token.animationUrl!.split(",")[1]!, "base64").toString(
                "utf8",
            ),
        ).toBe("<html>live</html>");
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

    it("passes trait catalog requests to the base read model", () => {
        let receivedKeys: string[] | undefined;
        let receivedScope: unknown;
        const readModel = new ExtensionAwareCollectionDetailRead(
            {
                ...createBaseReadPort(),
                listCollectionTraitCatalog(params: {
                    chainId: number;
                    collectionId: number;
                    keys: string[];
                    scopeTraitFilters?: Array<{ key: string; value: string }>;
                }): TraitCatalogFacet[] {
                    receivedKeys = params.keys;
                    receivedScope = params.scopeTraitFilters;
                    return [{ key: "Zone", values: [] }];
                },
            },
            createExtensionRecords(),
        );

        const facets = readModel.listCollectionTraitCatalog({
            chainId: 1,
            collectionId: 7,
            keys: ["Zone"],
            scopeTraitFilters: [{ key: "Level", value: "14" }],
        });

        expect(facets).toEqual([{ key: "Zone", values: [] }]);
        expect(receivedKeys).toEqual(["Zone"]);
        expect(receivedScope).toEqual([{ key: "Level", value: "14" }]);
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

function createLiveExtensionRecords() {
    return {
        ...createExtensionRecords(),
        getInstallByCollectionId() {
            return {
                chainId: 1,
                collectionId: 7,
                extensionKey: TERRAFORMS_EXTENSION_KEY,
                enabled: true,
                configJson: JSON.stringify({
                    mainContractAddress: TERRAFORMS_MAIN_CONTRACT,
                    rendererV2ContractAddress: TERRAFORMS_RENDERER_V2_CONTRACT,
                    tokenUriV2ContractAddress: TERRAFORMS_TOKEN_URI_V2_CONTRACT,
                    beaconV2ContractAddress: TERRAFORMS_BEACON_V2_CONTRACT,
                }),
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:00Z",
            };
        },
    };
}

function tokenCard(tokenId: string, image: string): TokenCard {
    return {
        tokenId,
        marketplaceBiddingSupported: true,
        name: null,
        image,
        animationUrl: null,
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
        address: TERRAFORMS_MAIN_CONTRACT,
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
        listCollectionTraitCatalog() {
            throw new Error("Unexpected listCollectionTraitCatalog call");
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
        countMarketplaceBiddingSupportedTokensByIds() {
            throw new Error(
                "Unexpected countMarketplaceBiddingSupportedTokensByIds call",
            );
        },
    };
}
