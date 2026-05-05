import {
    COLLECTION_MEDIA_MODES,
    type CollectionExtensionInstall,
    type CollectionMediaMode,
    type CollectionMediaPresentation,
} from "@artgod/shared/extensions";
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
    ): TraitFacet[];
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
    ) {}

    resolveCollectionRef(
        chainId: number,
        collectionRef: string,
    ): CollectionListItem {
        return this.baseReadPort.resolveCollectionRef(chainId, collectionRef);
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

        return {
            ...page,
            items: page.items.map((token) =>
                extension.resolveTokenCard(
                    install,
                    token,
                    this.resolveMediaContext(
                        install,
                        extension,
                        params.chainId,
                        params.collectionId,
                        token.tokenId,
                        mediaState.selectedMode,
                    ),
                ),
            ),
        };
    }

    listCollectionTraitFacets(
        chainId: number,
        collectionId: number,
        owner?: string,
    ): TraitFacet[] {
        return this.baseReadPort.listCollectionTraitFacets(
            chainId,
            collectionId,
            owner,
        );
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

        return tokens.map((token) =>
            extension.resolveTokenCard(
                install,
                token,
                this.resolveMediaContext(
                    install,
                    extension,
                    params.chainId,
                    params.collectionId,
                    token.tokenId,
                    mediaState.selectedMode,
                ),
            ),
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
