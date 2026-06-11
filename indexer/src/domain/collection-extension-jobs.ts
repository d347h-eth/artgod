import type { CollectionExtensionKey } from "@artgod/shared/extensions";

export const COLLECTION_EXTENSION_JOB_KIND = {
    RefreshArtifacts: "collection-extension.refresh-artifacts",
} as const;

// Collection-extension job id scopes keep queue de-duplication ids consistent.
export const COLLECTION_EXTENSION_JOB_ID_SCOPE = {
    RefreshArtifacts: "collection-extension:artifacts",
    BootstrapArtifacts: "collection-extension:bootstrap-artifacts",
} as const;

// Optional bootstrap context lets generic artifact jobs report step progress.
export type CollectionExtensionBootstrapContext = {
    runId: number;
    extensionKey: CollectionExtensionKey;
};

export type CollectionExtensionRefreshArtifactsPayload = {
    chainId: number;
    collectionId: number;
    contract: string;
    tokenId: string;
    reason: string;
    source?: string | null;
    bootstrap?: CollectionExtensionBootstrapContext | null;
};
