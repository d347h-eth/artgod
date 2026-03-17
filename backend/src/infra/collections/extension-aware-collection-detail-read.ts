import {
    COLLECTION_EXTENSION_KEYS,
    TERRAFORMS_EXTENSION_ARTIFACT_REFS,
    type CollectionExtensionInstall,
} from "@artgod/shared/extensions";
import type { BackendCollectionExtensionArtifactRecord } from "../../application/collection-extensions/types.js";
import type {
    CollectionHolderPage,
    CollectionListItem,
    TokenBrowserStatus,
    TokenCursorPage,
    TokenDetail,
    TraitFacet,
    TraitFilter,
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
        owner?: string;
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
    }): TokenDetail;
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

    listCollectionTokens(params: {
        chainId: number;
        collectionId: number;
        tokenStatus: TokenBrowserStatus;
        limit: number;
        cursor?: string;
        traitFilters?: TraitFilter[];
        owner?: string;
    }): TokenCursorPage {
        const page = this.baseReadPort.listCollectionTokens(params);
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
                    this.resolvePresentationArtifact(
                        install,
                        params.chainId,
                        params.collectionId,
                        token.tokenId,
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
    }): TokenDetail {
        const token = this.baseReadPort.getCollectionTokenDetail(params);
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
            this.resolvePresentationArtifact(
                install,
                params.chainId,
                params.collectionId,
                params.tokenId,
            ),
        );
    }

    private resolvePresentationArtifact(
        install: CollectionExtensionInstall,
        chainId: number,
        collectionId: number,
        tokenId: string,
    ) {
        if (install.extensionKey === COLLECTION_EXTENSION_KEYS.Terraforms) {
            return this.extensionRecords.getArtifact({
                chainId,
                collectionId,
                tokenId,
                extensionKey: install.extensionKey,
                artifactRef: TERRAFORMS_EXTENSION_ARTIFACT_REFS.V2Media,
            });
        }

        return null;
    }
}
