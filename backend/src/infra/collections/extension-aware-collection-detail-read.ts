import {
    COLLECTION_EXTENSION_KEYS,
    TERRAFORMS_EXTENSION_ARTIFACT_REFS,
    type CollectionExtensionInstall,
} from "@artgod/shared/extensions";
import type {
    BackendCollectionExtensionArtifactRecord,
} from "../../application/collection-extensions/types.js";
import type {
    CollectionListItem,
    TokenBrowserStatus,
    TokenCursorPage,
    TokenDetail,
    TraitFacet,
    TraitFilter,
} from "@artgod/shared/types/browse";
import { resolveBackendCollectionExtension } from "../../application/collection-extensions/index.js";

type CollectionExtensionRecordsPort = {
    getInstallByContract(
        chainId: number,
        contractAddress: string,
    ): CollectionExtensionInstall | null;
    getArtifact(params: {
        chainId: number;
        contractAddress: string;
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
        contractAddress: string;
        tokenStatus: TokenBrowserStatus;
        limit: number;
        cursor?: string;
        traitFilters?: TraitFilter[];
    }): TokenCursorPage;
    listCollectionTraitFacets(
        chainId: number,
        contractAddress: string,
    ): TraitFacet[];
    getCollectionTokenDetail(params: {
        chainId: number;
        contractAddress: string;
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
        contractAddress: string;
        tokenStatus: TokenBrowserStatus;
        limit: number;
        cursor?: string;
        traitFilters?: TraitFilter[];
    }): TokenCursorPage {
        const page = this.baseReadPort.listCollectionTokens(params);
        const install = this.extensionRecords.getInstallByContract(
            params.chainId,
            params.contractAddress,
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
                        params.contractAddress,
                        token.tokenId,
                    ),
                ),
            ),
        };
    }

    listCollectionTraitFacets(
        chainId: number,
        contractAddress: string,
    ): TraitFacet[] {
        return this.baseReadPort.listCollectionTraitFacets(
            chainId,
            contractAddress,
        );
    }

    getCollectionTokenDetail(params: {
        chainId: number;
        contractAddress: string;
        tokenId: string;
    }): TokenDetail {
        const token = this.baseReadPort.getCollectionTokenDetail(params);
        const install = this.extensionRecords.getInstallByContract(
            params.chainId,
            params.contractAddress,
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
                params.contractAddress,
                params.tokenId,
            ),
        );
    }

    private resolvePresentationArtifact(
        install: CollectionExtensionInstall,
        chainId: number,
        contractAddress: string,
        tokenId: string,
    ) {
        if (install.extensionKey === COLLECTION_EXTENSION_KEYS.Terraforms) {
            return this.extensionRecords.getArtifact({
                chainId,
                contractAddress,
                tokenId,
                extensionKey: install.extensionKey,
                artifactRef: TERRAFORMS_EXTENSION_ARTIFACT_REFS.V2Media,
            });
        }

        return null;
    }
}
