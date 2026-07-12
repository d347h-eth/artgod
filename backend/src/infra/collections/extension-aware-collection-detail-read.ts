import {
    COLLECTION_MEDIA_MODE_OPTIONS,
    COLLECTION_MEDIA_MODES,
    type CollectionExtensionInstall,
    type CollectionMediaMode,
    type CollectionMediaPreferenceValue,
    type CollectionMediaPresentation,
    type TokenMediaPresentation,
} from "@artgod/shared/extensions";
import { ARTGOD_SPAN_ATTRIBUTE } from "@artgod/shared/observability";
import { NOOP_APM, type ApmPort } from "@artgod/shared/observability/apm";
import type {
    BackendCollectionExtensionArtifactRecord,
    BackendCollectionExtensionCanonicalMediaRecord,
    BackendCollectionExtensionMediaContext,
    BackendCollectionExtensionRenderContext,
} from "../../application/collection-extensions/types.js";
import type {
    CollectionMediaState,
    CollectionHolderPage,
    CollectionListItem,
    TokenCard,
    TokenBrowserStatus,
    TokenCursorPage,
    TokenDetail,
    TokenMediaPreview,
    TokenMediaState,
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
    getCanonicalTokenMediaFacts(params: {
        chainId: number;
        collectionId: number;
        tokenId: string;
    }): BackendCollectionExtensionCanonicalMediaRecord;
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
        mediaPreference?: CollectionMediaPreferenceValue;
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
        mediaPreference?: CollectionMediaPreferenceValue;
        mediaVariant?: string;
    }): TokenDetail;
    getCollectionTokenPreview(params: {
        chainId: number;
        collectionId: number;
        tokenId: string;
        mediaMode?: CollectionMediaMode;
        mediaPreference?: CollectionMediaPreferenceValue;
        mediaVariant?: string;
    }): TokenMediaPreview;
    listCollectionTokenCardsByIds(params: {
        chainId: number;
        collectionId: number;
        tokenIds: string[];
        mediaMode?: CollectionMediaMode;
        mediaPreference?: CollectionMediaPreferenceValue;
        includeListings?: boolean;
    }): TokenCard[];
    countMarketplaceBiddingSupportedTokensByIds(params: {
        chainId: number;
        collectionId: number;
        tokenIds: string[];
    }): number;
};

type CollectionTokenMediaQuery = {
    chainId: number;
    collectionId: number;
    tokenId: string;
    mediaMode?: CollectionMediaMode;
    mediaPreference?: CollectionMediaPreferenceValue;
    mediaVariant?: string;
};

type ResolvedBackendCollectionExtension = NonNullable<
    ReturnType<typeof resolveBackendCollectionExtension>
>;

type ResolvedTokenMediaContext = {
    media: TokenMediaPresentation;
    install: CollectionExtensionInstall | null;
    extension: ResolvedBackendCollectionExtension | null;
    context: BackendCollectionExtensionMediaContext | null;
};

export class ExtensionAwareCollectionDetailRead {
    constructor(
        private readonly baseReadPort: CollectionDetailReadPort,
        private readonly extensionRecords: CollectionExtensionRecordsPort,
        private readonly apm: ApmPort = NOOP_APM,
        private readonly rpc?: BackendCollectionExtensionRenderContext["rpc"],
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
        mediaPreference?: CollectionMediaPreferenceValue;
    }): CollectionMediaState {
        return this.resolveCollectionMediaState(params);
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
        mediaPreference?: CollectionMediaPreferenceValue;
    }): TokenCursorPage {
        const page = this.baseReadPort.listCollectionTokens(params);
        const mediaState = this.resolveCollectionMediaState(params);

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
        const artifactRef = extension.resolveTokenCardArtifactRef(install, {
            mediaMode: mediaState.selectedMode,
            mediaPreferenceEnabled: mediaState.preference?.enabled ?? false,
        });
        if (!artifactRef) {
            return page;
        }
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
                    mediaVariant: null,
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

    async getCollectionTokenDetailPresentation(
        params: CollectionTokenMediaQuery,
    ): Promise<{ media: TokenMediaState; token: TokenDetail }> {
        // Read canonical token data before applying the extension-owned presentation.
        const token = this.baseReadPort.getCollectionTokenDetail(params);
        const resolved = await this.resolveTokenMediaContext(params);
        if (!resolved.install || !resolved.extension || !resolved.context) {
            return { media: resolved.media, token };
        }

        // Render with the same artifact and RPC context used to select the media state.
        const presentedToken = await resolved.extension.resolveTokenDetail(
            resolved.install,
            token,
            resolved.context,
        );
        return { media: resolved.media, token: presentedToken };
    }

    async getCollectionTokenDetail(
        params: CollectionTokenMediaQuery,
    ): Promise<TokenDetail> {
        return (await this.getCollectionTokenDetailPresentation(params)).token;
    }

    async getCollectionTokenPreviewPresentation(
        params: CollectionTokenMediaQuery,
    ): Promise<{ media: TokenMediaState; token: TokenMediaPreview }> {
        // Read canonical token data before applying the extension-owned presentation.
        const token = this.baseReadPort.getCollectionTokenPreview(params);
        const resolved = await this.resolveTokenMediaContext(params);
        if (!resolved.install || !resolved.extension || !resolved.context) {
            return { media: resolved.media, token };
        }

        // Render with the same artifact and RPC context used to select the media state.
        const presentedToken = await resolved.extension.resolveTokenPreview(
            resolved.install,
            token,
            resolved.context,
        );
        return { media: resolved.media, token: presentedToken };
    }

    listCollectionTokenCardsByIds(params: {
        chainId: number;
        collectionId: number;
        tokenIds: string[];
        mediaMode?: CollectionMediaMode;
        mediaPreference?: CollectionMediaPreferenceValue;
        includeListings?: boolean;
    }): TokenCard[] {
        const tokens = this.baseReadPort.listCollectionTokenCardsByIds(params);
        const mediaState = this.resolveCollectionMediaState(params);

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

        const artifactRef = extension.resolveTokenCardArtifactRef(install, {
            mediaMode: mediaState.selectedMode,
            mediaPreferenceEnabled: mediaState.preference?.enabled ?? false,
        });
        if (!artifactRef) {
            return tokens;
        }
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
                mediaVariant: null,
                artifact: artifactsByTokenId.get(token.tokenId) ?? null,
            }),
        );
    }

    countMarketplaceBiddingSupportedTokensByIds(params: {
        chainId: number;
        collectionId: number;
        tokenIds: string[];
    }): number {
        return this.baseReadPort.countMarketplaceBiddingSupportedTokensByIds(
            params,
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
        mediaPreference?: CollectionMediaPreferenceValue;
    }): CollectionMediaPresentation {
        const install = this.extensionRecords.getInstallByCollectionId(
            params.chainId,
            params.collectionId,
        );
        const extension = install?.enabled
            ? resolveBackendCollectionExtension(install)
            : null;
        return this.resolveCollectionMediaPresentation(
            params,
            install,
            extension,
        );
    }

    private resolveCollectionMediaPresentation(
        params: {
            mediaMode?: CollectionMediaMode;
            mediaPreference?: CollectionMediaPreferenceValue;
        },
        install: CollectionExtensionInstall | null,
        extension: ResolvedBackendCollectionExtension | null,
    ): CollectionMediaPresentation {
        if (!install?.enabled || !extension) {
            return {
                selectedMode: COLLECTION_MEDIA_MODES.Snapshot,
                defaultMode: COLLECTION_MEDIA_MODES.Snapshot,
                availableModes: [{ ...COLLECTION_MEDIA_MODE_OPTIONS.Snapshot }],
                preference: null,
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
            preference:
                extension.resolveMediaPreference?.(
                    install,
                    params.mediaPreference,
                ) ?? null,
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

    private async resolveTokenMediaContext(
        params: CollectionTokenMediaQuery,
    ): Promise<ResolvedTokenMediaContext> {
        const install = this.extensionRecords.getInstallByCollectionId(
            params.chainId,
            params.collectionId,
        );
        const extension = install?.enabled
            ? resolveBackendCollectionExtension(install)
            : null;
        const defaultMedia = this.resolveDefaultTokenMediaState(
            params,
            install,
            extension,
        );
        if (!install?.enabled || !extension) {
            return {
                media: defaultMedia,
                install: null,
                extension: null,
                context: null,
            };
        }

        const rpc = createRequestScopedRpc(this.rpc);
        const artifactCache = new Map<
            string,
            BackendCollectionExtensionArtifactRecord | null
        >();
        const getArtifact = (
            artifactRef: string,
        ): BackendCollectionExtensionArtifactRecord | null => {
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
        };

        let media = defaultMedia;
        if (extension.resolveTokenMediaPresentation) {
            // Read canonical facts once for token-level variant selection.
            const canonical = this.extensionRecords.getCanonicalTokenMediaFacts(
                {
                    chainId: params.chainId,
                    collectionId: params.collectionId,
                    tokenId: params.tokenId,
                },
            );
            media =
                (await extension.resolveTokenMediaPresentation(install, {
                    tokenId: params.tokenId,
                    requestedMode: params.mediaMode,
                    requestedPreference: params.mediaPreference,
                    requestedVariant: params.mediaVariant,
                    canonical: {
                        isCanonicalToken: canonical.isCanonicalToken,
                        animationUrl: canonical.animationUrl,
                        getAttributeValue: (key) =>
                            canonical.attributes.get(key) ?? null,
                    },
                    getArtifact,
                    rpc,
                })) ?? defaultMedia;
        }

        const artifactRef = extension.resolveTokenArtifactRef(install, {
            mediaMode: media.selectedMode,
            mediaVariant: media.selectedVariant,
        });

        return {
            media,
            install,
            extension,
            context: {
                mediaMode: media.selectedMode,
                mediaVariant: media.selectedVariant,
                artifact: artifactRef ? getArtifact(artifactRef) : null,
                rpc,
            },
        };
    }

    private resolveDefaultTokenMediaState(
        params: {
            mediaMode?: CollectionMediaMode;
            mediaPreference?: CollectionMediaPreferenceValue;
        },
        install: CollectionExtensionInstall | null,
        extension: ResolvedBackendCollectionExtension | null,
    ): TokenMediaPresentation {
        return {
            ...this.resolveCollectionMediaPresentation(
                params,
                install,
                extension,
            ),
            selectedVariant: null,
            defaultVariant: null,
            availableVariants: [],
        };
    }
}

type BackendCollectionExtensionRpc =
    BackendCollectionExtensionRenderContext["rpc"];
type BackendContractReadParams = Parameters<
    BackendCollectionExtensionRpc["readContract"]
>[0];
type BackendStorageReadParams = Parameters<
    BackendCollectionExtensionRpc["getStorageAt"]
>[0];

function createRequestScopedRpc(
    rpc: BackendCollectionExtensionRpc | undefined,
): BackendCollectionExtensionRpc | undefined {
    if (!rpc) {
        return undefined;
    }

    let currentBlockNumberRead: Promise<number> | undefined;
    const storageReads: Array<{
        params: BackendStorageReadParams;
        result: ReturnType<BackendCollectionExtensionRpc["getStorageAt"]>;
    }> = [];

    return {
        readContract<T = unknown>(
            params: BackendContractReadParams,
        ): Promise<T> {
            return rpc.readContract<T>(params);
        },
        getStorageAt(params) {
            const cached = storageReads.find(
                (read) =>
                    read.params.address === params.address &&
                    read.params.slot === params.slot &&
                    read.params.blockNumber === params.blockNumber,
            );
            if (cached) {
                return cached.result;
            }

            const result = rpc.getStorageAt(params);
            storageReads.push({ params: { ...params }, result });
            return result;
        },
        getCurrentBlockNumber() {
            currentBlockNumberRead ??= rpc.getCurrentBlockNumber();
            return currentBlockNumberRead;
        },
        getBlockTimestamp(blockNumber) {
            return rpc.getBlockTimestamp(blockNumber);
        },
    };
}
