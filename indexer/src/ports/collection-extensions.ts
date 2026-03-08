import type {
    CollectionExtensionInstall,
    CollectionExtensionKey,
} from "@artgod/shared/extensions";

export type CollectionExtensionArtifactUpsertInput = {
    chainId: number;
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

export type CollectionExtensionArtifactRecord = {
    chainId: number;
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
    getInstallByContract(
        chainId: number,
        contractAddress: string,
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
        contractAddress: string;
        tokenId: string;
        extensionKey: CollectionExtensionKey;
        artifactRef: string;
    }): CollectionExtensionArtifactRecord | null;
    getTokenAttributeValue(params: {
        chainId: number;
        contractAddress: string;
        tokenId: string;
        key: string;
    }): string | null;
}
