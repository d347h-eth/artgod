import type {
    CollectionExtensionInstall,
    CollectionExtensionKey,
} from "@artgod/shared/extensions";
import type { ImageCachePolicyConfig } from "@artgod/shared/media/token-image-cache";
import type {
    CollectionExtensionEvent,
    CollectionExtensionEventMedia,
    MetadataRefreshEvent,
    MetadataRefreshRangeEvent,
} from "../../domain/onchain.js";
import type { RpcEvent, RpcLog, RpcProviderPort } from "../../ports/rpc.js";
import type {
    CollectionExtensionAttributePort,
    CollectionExtensionArtifactPort,
    CollectionExtensionInstallPort,
} from "../../ports/collection-extensions.js";
import type { MetadataFetcherPort } from "../../ports/metadata.js";

export type CollectionExtensionSyncDecodeResult = {
    metadataRefreshEvents: MetadataRefreshEvent[];
    metadataRefreshRangeEvents: MetadataRefreshRangeEvent[];
    collectionExtensionEvents: CollectionExtensionEvent[];
    collectionExtensionEventMedia: CollectionExtensionEventMedia[];
};

export type CollectionExtensionSyncDecodeContext = {
    rpc: RpcProviderPort;
};

export type CollectionExtensionSyncWatchSpec = {
    collectionId: number;
    sourceId: string;
    address: `0x${string}` | `0x${string}`[];
    events: readonly RpcEvent[];
    decode(
        log: RpcLog,
        context: CollectionExtensionSyncDecodeContext,
    ):
        | CollectionExtensionSyncDecodeResult
        | Promise<CollectionExtensionSyncDecodeResult>;
};

export type CollectionExtensionArtifactRefreshContext = {
    rpc: RpcProviderPort;
    metadataFetcher: MetadataFetcherPort;
    installs: CollectionExtensionInstallPort;
    artifacts: CollectionExtensionArtifactPort;
    attributes: CollectionExtensionAttributePort;
    install: CollectionExtensionInstall;
    payload: {
        chainId: number;
        collectionId: number;
        contract: string;
        tokenId: string;
        reason: string;
        source?: string | null;
    };
};

// Signals follow-up work needed after a collection-extension artifact refresh.
export type CollectionExtensionArtifactRefreshResult = {
    attributesChanged: boolean;
};

export interface IndexerCollectionExtension {
    key: CollectionExtensionKey;
    resolveImageCachePolicyConfig?(
        install: CollectionExtensionInstall,
    ): ImageCachePolicyConfig | null;
    buildSyncWatchSpecs(
        install: CollectionExtensionInstall,
    ): CollectionExtensionSyncWatchSpec[];
    refreshArtifacts(
        context: CollectionExtensionArtifactRefreshContext,
    ): Promise<CollectionExtensionArtifactRefreshResult>;
}
