import {
    COLLECTION_MEDIA_MODES,
    type CollectionExtensionInstall,
    type CollectionMediaMode,
    type CollectionMediaPresentation,
} from "@artgod/shared/extensions";
import { ARTGOD_SPAN_ATTRIBUTE } from "@artgod/shared/observability";
import { NOOP_APM, type ApmPort } from "@artgod/shared/observability/apm";
import type { BackendCollectionExtensionArtifactRecord } from "../../application/collection-extensions/types.js";
import type {
    CollectionMediaState,
    CollectionHolderPage,
    CollectionListItem,
    TokenCard,
    TokenBrowserStatus,
    TokenCursorPage,
    TokenDetail,
    TokenMediaPreview,
    TraitCatalogFacet,
    TraitFacet,
    TraitFilter,
    TraitRangeFilter,
} from "@artgod/shared/types/browse";
import { resolveBackendCollectionExtension } from "../../application/collection-extensions/index.js";

type CollectionExtensionRecordsPort = {
    getInstallByCollectionId(
        chainId: number,
        collectionId: number,
    ): CollectionExtensionInstall | null;
    getArtifact(params: {
        chainId: number;
        collectionId: number;
        tokenId: string;
        extensionKey: CollectionExtensionInstall["extensionKey"];
        artifactRef: string;
    }): BackendCollectionExtensionArtifactRecord | null;
    listTokenCardArtifactsByTokenIds(params: {
        chainId: number;
        collectionId: number;
        tokenIds: string[];
        extensionKey: CollectionExtensionInstall["extensionKey"];
        artifactRef: string;
    }): Map<string, BackendCollectionExtensionArtifactRecord>;
};

type CollectionDetailReadPort = {
    resolveCollectionRef(
        chainId: number,
        collectionRef: string,
    ): CollectionListItem;
    listCollectionTokens(params: {
        chainId: number;
        collectionId: number;
        tokenStatus: TokenBrowserStatus;
        limit: number;
        cursor?: string;
        traitFilters?: TraitFilter[];
        traitRangeFilters?: TraitRangeFilter[];
        owner?: string;
        mediaMode?: CollectionMediaMode;
    }): TokenCursorPage;
    listCollectionTraitFacets(
        chainId: number,
        collectionId: number,
        owner?: string,
        options?: {
            excludeKeys?: string[];
            rangeOnlyKeys?: string[];
        },
    ): TraitFacet[];
    listCollectionTraitCatalog(params: {
        chainId: number;
        collectionId: number;
        keys: string[];
        scopeTraitFilters?: TraitFilter[];
    }): TraitCatalogFacet[];
    listCollectionHolders(params: {
        chainId: number;
        collectionId: number;
        limit: number;
        cursor?: string;
    }): CollectionHolderPage;
    getCollectionTokenDetail(params: {
        chainId: number;
        collectionId: number;
        tokenId: string;
        mediaMode?: CollectionMediaMode;
    }): TokenDetail;
    getCollectionTokenPreview(params: {
        chainId: number;
        collectionId: number;
        tokenId: string;
        mediaMode?: CollectionMediaMode;
    }): TokenMediaPreview;
    listCollectionTokenCardsByIds(params: {
        chainId: number;
        collectionId: number;
        tokenIds: string[];
        mediaMode?: CollectionMediaMode;
        includeListings?: boolean;
    }): TokenCard[];
};

export class ExtensionAwareCollectionDetailRead {
    constructor(
        private readonly baseReadPort: CollectionDetailReadPort,
        private readonly extensionRecords: CollectionExtensionRecordsPort,
        private readonly apm: ApmPort = NOOP_APM,
    ) {}

    resolveCollectionRef(
        chainId: number,
        collectionRef: string,
    ): CollectionListItem {
        const collection = this.baseReadPort.resolveCollectionRef(
            chainId,
            collectionRef,
        );
        return this.resolveCollectionExtensionPresentation(collection);
    }

    getCollectionMediaState(params: {
        chainId: number;
        collectionId: number;
        mediaMode?: CollectionMediaMode;
    }): CollectionMediaState {
        return this.resolveCollectionMediaState(params);
    }

    getCollectionTokenMediaState(params: {
        chainId: number;
        collectionId: number;
        tokenId: string;
        mediaMode?: CollectionMediaMode;
    }): CollectionMediaState {
        return this.resolveTokenMediaState(params);
    }

    listCollectionTokens(params: {
        chainId: number;
        collectionId: number;
        tokenStatus: TokenBrowserStatus;
        limit: number;
        cursor?: string;
        traitFilters?: TraitFilter[];
        traitRangeFilters?: TraitRangeFilter[];
        owner?: string;
        mediaMode?: CollectionMediaMode;
    }): TokenCursorPage {
        const page = this.baseReadPort.listCollectionTokens(params);
        const mediaState = this.resolveCollectionMediaState(params);
        if (mediaState.selectedMode === COLLECTION_MEDIA_MODES.Snapshot) {
            return page;
        }

        const install = this.extensionRecords.getInstallByCollectionId(
            params.chainId,
            params.collectionId,
        );
        if (!install?.enabled) {
            return page;
        }

        const extension = resolveBackendCollectionExtension(install);
        if (!extension) {
            return page;
        }
        const artifactRef = extension.resolveArtifactRef(
            install,
            mediaState.selectedMode,
        );
        const artifactsByTokenId = artifactRef
            ? this.listTokenCardArtifactsByTokenIds({
                  chainId: params.chainId,
                  collectionId: params.collectionId,
                  tokenIds: page.items.map((token) => token.tokenId),
                  install,
                  artifactRef,
              })
            : new Map<string, BackendCollectionExtensionArtifactRecord>();

        return {
            ...page,
            items: page.items.map((token) =>
                extension.resolveTokenCard(install, token, {
                    mediaMode: mediaState.selectedMode,
                    artifact: artifactsByTokenId.get(token.tokenId) ?? null,
                }),
            ),
        };
    }

    listCollectionTraitFacets(
        chainId: number,
        collectionId: number,
        owner?: string,
        options?: {
            excludeKeys?: string[];
            rangeOnlyKeys?: string[];
        },
    ): TraitFacet[] {
        return this.baseReadPort.listCollectionTraitFacets(
            chainId,
            collectionId,
            owner,
            {
                excludeKeys: options?.excludeKeys,
                rangeOnlyKeys: options?.rangeOnlyKeys,
            },
        );
    }

    listCollectionTraitCatalog(params: {
        chainId: number;
        collectionId: number;
        keys: string[];
        scopeTraitFilters?: TraitFilter[];
    }): TraitCatalogFacet[] {
        return this.baseReadPort.listCollectionTraitCatalog(params);
    }

    listCollectionHolders(params: {
        chainId: number;
        collectionId: number;
        limit: number;
        cursor?: string;
    }): CollectionHolderPage {
        return this.baseReadPort.listCollectionHolders(params);
    }

    getCollectionTokenDetail(params: {
        chainId: number;
        collectionId: number;
        tokenId: string;
        mediaMode?: CollectionMediaMode;
    }): TokenDetail {
        const token = this.baseReadPort.getCollectionTokenDetail(params);
        const mediaState = this.resolveTokenMediaState(params);
        if (mediaState.selectedMode === COLLECTION_MEDIA_MODES.Snapshot) {
            return token;
        }

        const install = this.extensionRecords.getInstallByCollectionId(
            params.chainId,
            params.collectionId,
        );
        if (!install?.enabled) {
            return token;
        }

        const extension = resolveBackendCollectionExtension(install);
        if (!extension) {
            return token;
        }

        return extension.resolveTokenDetail(
            install,
            token,
            this.resolveMediaContext(
                install,
                extension,
                params.chainId,
                params.collectionId,
                params.tokenId,
                mediaState.selectedMode,
            ),
        );
    }

    getCollectionTokenPreview(params: {
        chainId: number;
        collectionId: number;
        tokenId: string;
        mediaMode?: CollectionMediaMode;
    }): TokenMediaPreview {
        const token = this.baseReadPort.getCollectionTokenPreview(params);
        const mediaState = this.resolveTokenMediaState(params);
        if (mediaState.selectedMode === COLLECTION_MEDIA_MODES.Snapshot) {
            return token;
        }

        const install = this.extensionRecords.getInstallByCollectionId(
            params.chainId,
            params.collectionId,
        );
        if (!install?.enabled) {
            return token;
        }

        const extension = resolveBackendCollectionExtension(install);
        if (!extension) {
            return token;
        }

        return extension.resolveTokenPreview(
            install,
            token,
            this.resolveMediaContext(
                install,
                extension,
                params.chainId,
                params.collectionId,
                params.tokenId,
                mediaState.selectedMode,
            ),
        );
    }

    listCollectionTokenCardsByIds(params: {
        chainId: number;
        collectionId: number;
        tokenIds: string[];
        mediaMode?: CollectionMediaMode;
        includeListings?: boolean;
    }): TokenCard[] {
        const tokens = this.baseReadPort.listCollectionTokenCardsByIds(params);
        const mediaState = this.resolveCollectionMediaState(params);
        if (mediaState.selectedMode === COLLECTION_MEDIA_MODES.Snapshot) {
            return tokens;
        }

        const install = this.extensionRecords.getInstallByCollectionId(
            params.chainId,
            params.collectionId,
        );
        if (!install?.enabled) {
            return tokens;
        }

        const extension = resolveBackendCollectionExtension(install);
        if (!extension) {
            return tokens;
        }

        const artifactRef = extension.resolveArtifactRef(
            install,
            mediaState.selectedMode,
        );
        const artifactsByTokenId = artifactRef
            ? this.listTokenCardArtifactsByTokenIds({
                  chainId: params.chainId,
                  collectionId: params.collectionId,
                  tokenIds: tokens.map((token) => token.tokenId),
                  install,
                  artifactRef,
              })
            : new Map<string, BackendCollectionExtensionArtifactRecord>();

        return tokens.map((token) =>
            extension.resolveTokenCard(install, token, {
                mediaMode: mediaState.selectedMode,
                artifact: artifactsByTokenId.get(token.tokenId) ?? null,
            }),
        );
    }

    private listTokenCardArtifactsByTokenIds(params: {
        chainId: number;
        collectionId: number;
        tokenIds: string[];
        install: CollectionExtensionInstall;
        artifactRef: string;
    }): Map<string, BackendCollectionExtensionArtifactRecord> {
        // Batch artifact lookup keeps token-card hydration from issuing one extension query per token.
        return this.apm.withSyncSpan(
            "backend.extension.artifacts_batch",
            {
                [ARTGOD_SPAN_ATTRIBUTE.ChainId]: params.chainId,
                [ARTGOD_SPAN_ATTRIBUTE.CollectionId]: params.collectionId,
                [ARTGOD_SPAN_ATTRIBUTE.ExtensionKey]:
                    params.install.extensionKey,
                [ARTGOD_SPAN_ATTRIBUTE.ExtensionArtifactRef]:
                    params.artifactRef,
                [ARTGOD_SPAN_ATTRIBUTE.TokensCount]: params.tokenIds.length,
            },
            () =>
                this.extensionRecords.listTokenCardArtifactsByTokenIds({
                    chainId: params.chainId,
                    collectionId: params.collectionId,
                    tokenIds: params.tokenIds,
                    extensionKey: params.install.extensionKey,
                    artifactRef: params.artifactRef,
                }),
        );
    }

    private resolveCollectionMediaState(params: {
        chainId: number;
        collectionId: number;
        mediaMode?: CollectionMediaMode;
    }): CollectionMediaPresentation {
        const install = this.extensionRecords.getInstallByCollectionId(
            params.chainId,
            params.collectionId,
        );
        if (!install?.enabled) {
            return {
                selectedMode: COLLECTION_MEDIA_MODES.Snapshot,
                defaultMode: COLLECTION_MEDIA_MODES.Snapshot,
                availableModes: [
                    {
                        key: COLLECTION_MEDIA_MODES.Snapshot,
                        label: "snapshot",
                    },
                ],
            };
        }

        const extension = resolveBackendCollectionExtension(install);
        if (!extension) {
            return {
                selectedMode: COLLECTION_MEDIA_MODES.Snapshot,
                defaultMode: COLLECTION_MEDIA_MODES.Snapshot,
                availableModes: [
                    {
                        key: COLLECTION_MEDIA_MODES.Snapshot,
                        label: "snapshot",
                    },
                ],
            };
        }

        const availableModes = extension.listMediaModes(install);
        const defaultMode = extension.defaultMediaMode(install);
        const selectedMode =
            params.mediaMode &&
            availableModes.some((mode) => mode.key === params.mediaMode)
                ? params.mediaMode
                : defaultMode;

        return {
            selectedMode,
            defaultMode,
            availableModes,
        };
    }

    private resolveCollectionExtensionPresentation(
        collection: CollectionListItem,
    ): CollectionListItem {
        const attributes = {
            [ARTGOD_SPAN_ATTRIBUTE.ChainId]: collection.chainId,
            [ARTGOD_SPAN_ATTRIBUTE.CollectionId]: collection.collectionId,
        };
        const install = this.apm.withSyncSpan(
            "backend.extension.install_lookup",
            attributes,
            () =>
                this.extensionRecords.getInstallByCollectionId(
                    collection.chainId,
                    collection.collectionId,
                ),
        );
        if (!install?.enabled) {
            return collection;
        }

        const extensionAttributes = {
            ...attributes,
            [ARTGOD_SPAN_ATTRIBUTE.ExtensionKey]: install.extensionKey,
        };
        const extension = this.apm.withSyncSpan(
            "backend.extension.resolve",
            extensionAttributes,
            () => resolveBackendCollectionExtension(install),
        );
        const activityEventFeeds = extension
            ? this.apm.withSyncSpan(
                  "backend.extension.activity_event_feeds",
                  extensionAttributes,
                  () => extension.listActivityEventFeeds(install),
              )
            : collection.activityEventFeeds;

        return {
            ...collection,
            extensions: [{ key: install.extensionKey }],
            activityEventFeeds,
        };
    }

    private resolveTokenMediaState(params: {
        chainId: number;
        collectionId: number;
        tokenId: string;
        mediaMode?: CollectionMediaMode;
    }): CollectionMediaPresentation {
        const install = this.extensionRecords.getInstallByCollectionId(
            params.chainId,
            params.collectionId,
        );
        if (!install?.enabled) {
            return this.resolveCollectionMediaState(params);
        }

        const extension = resolveBackendCollectionExtension(install);
        if (!extension?.resolveTokenMediaPresentation) {
            return this.resolveCollectionMediaState(params);
        }

        const artifactCache = new Map<
            string,
            BackendCollectionExtensionArtifactRecord | null
        >();
        const mediaState = extension.resolveTokenMediaPresentation(install, {
            requestedMode: params.mediaMode,
            getArtifact: (artifactRef) => {
                if (!artifactCache.has(artifactRef)) {
                    artifactCache.set(
                        artifactRef,
                        this.extensionRecords.getArtifact({
                            chainId: params.chainId,
                            collectionId: params.collectionId,
                            tokenId: params.tokenId,
                            extensionKey: install.extensionKey,
                            artifactRef,
                        }),
                    );
                }
                return artifactCache.get(artifactRef) ?? null;
            },
        });

        return mediaState ?? this.resolveCollectionMediaState(params);
    }

    private resolveMediaContext(
        install: CollectionExtensionInstall,
        extension: NonNullable<
            ReturnType<typeof resolveBackendCollectionExtension>
        >,
        chainId: number,
        collectionId: number,
        tokenId: string,
        mediaMode: CollectionMediaMode,
    ) {
        const artifactRef = extension.resolveArtifactRef(install, mediaMode);
        const artifact = artifactRef
            ? this.extensionRecords.getArtifact({
                  chainId,
                  collectionId,
                  tokenId,
                  extensionKey: install.extensionKey,
                  artifactRef,
              })
            : null;

        return {
            mediaMode,
            artifact,
        };
    }
}
