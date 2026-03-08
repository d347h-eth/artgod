export const COLLECTION_EXTENSION_JOB_KIND = {
    RefreshArtifacts: "collection-extension.refresh-artifacts",
} as const;

export type CollectionExtensionRefreshArtifactsPayload = {
    chainId: number;
    collectionId?: number | null;
    contract: string;
    tokenId: string;
    reason: string;
    source?: string | null;
};
