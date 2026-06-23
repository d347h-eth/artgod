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
    CollectionExtensionSyntheticTokenPort,
} from "../../ports/collection-extensions.js";
import type { BootstrapCollectionExtensionArtifactTaskSeed } from "../../ports/bootstrap.js";
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
    syntheticTokens: CollectionExtensionSyntheticTokenPort;
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

export type CollectionExtensionBootstrapArtifactTaskPort = {
    insertCollectionExtensionArtifactTasks(
        rows: BootstrapCollectionExtensionArtifactTaskSeed[],
    ): number;
};

export type CollectionExtensionBootstrapArtifactSeedContext = {
    rpc: RpcProviderPort;
    install: CollectionExtensionInstall;
    tasks: CollectionExtensionBootstrapArtifactTaskPort;
    run: {
        runId: number;
        chainId: number;
        collectionId: number;
        contract: string;
    };
};

// Reports extension-owned artifact tasks added to a bootstrap side lane.
export type CollectionExtensionBootstrapArtifactSeedResult = {
    tasksSeeded: number;
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
    seedBootstrapArtifactTasks?(
        context: CollectionExtensionBootstrapArtifactSeedContext,
    ): Promise<CollectionExtensionBootstrapArtifactSeedResult>;
    refreshArtifacts(
        context: CollectionExtensionArtifactRefreshContext,
    ): Promise<CollectionExtensionArtifactRefreshResult>;
}
