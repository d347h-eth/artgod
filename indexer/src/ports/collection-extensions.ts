import type {
    CollectionExtensionInstall,
    CollectionExtensionKey,
} from "@artgod/shared/extensions";

export type CollectionExtensionArtifactUpsertInput = {
    chainId: number;
    collectionId: number;
    contractAddress: string;
    tokenId: string;
    extensionKey: CollectionExtensionKey;
    artifactRef: string;
    uri: string | null;
    rawJson: string | null;
    attributesJson: string | null;
    image: string | null;
    animationUrl: string | null;
    htmlContent: string | null;
};

// Normalized trait pair supplied by collection-extension enrichment logic.
export type CollectionExtensionTokenAttributeInput = {
    key: string;
    value: string;
};

// Replaces one extension's owned normalized traits for a token.
export type CollectionExtensionTokenAttributesReplaceInput = {
    chainId: number;
    collectionId: number;
    contractAddress: string;
    tokenId: string;
    extensionKey: CollectionExtensionKey;
    attributes: readonly CollectionExtensionTokenAttributeInput[];
};

export type CollectionExtensionArtifactRecord = {
    chainId: number;
    collectionId: number;
    contractAddress: string;
    tokenId: string;
    extensionKey: CollectionExtensionKey;
    artifactRef: string;
    uri: string | null;
    rawJson: string | null;
    attributesJson: string | null;
    image: string | null;
    animationUrl: string | null;
    htmlContent: string | null;
    createdAt: string;
    updatedAt: string;
};

export interface CollectionExtensionInstallPort {
    getInstall(
        chainId: number,
        collectionId: number,
    ): CollectionExtensionInstall | null;
    listEnabledInstalls(chainId: number): CollectionExtensionInstall[];
    upsertInstall(input: {
        chainId: number;
        collectionId: number;
        extensionKey: CollectionExtensionKey;
        enabled: boolean;
        configJson: string;
    }): void;
}

export interface CollectionExtensionArtifactPort {
    upsertArtifact(input: CollectionExtensionArtifactUpsertInput): void;
    getArtifact(params: {
        chainId: number;
        collectionId: number;
        tokenId: string;
        extensionKey: CollectionExtensionKey;
        artifactRef: string;
    }): CollectionExtensionArtifactRecord | null;
    getTokenAttributeValue(params: {
        chainId: number;
        collectionId: number;
        tokenId: string;
        key: string;
    }): string | null;
}

// Persists extension-owned normalized traits without mutating tokenURI metadata.
export interface CollectionExtensionAttributePort {
    replaceTokenAttributes(
        input: CollectionExtensionTokenAttributesReplaceInput,
    ): void;
}
