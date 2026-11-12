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
import type { ChainBlockReference } from "../../domain/chain-sync.js";
import type { TokenMetadata } from "../../domain/metadata.js";
import type {
    MetadataContentRetryPolicy,
    MetadataTarget,
} from "../../domain/metadata-pending.js";

/** Required snapshot inventory, separate from eventual artifact enrichment. */
export type CollectionExtensionBootstrapEnumerationContext = {
    rpc: Pick<RpcProviderPort, "getLogs" | "getBlock" | "readContractAtBlock">;
    install: CollectionExtensionInstall;
    contract: string;
    anchor: ChainBlockReference;
    onProgress(progress: { resolved: number; total: number | null }): void;
};

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

export type CollectionExtensionBootstrapArtifactSeedContext = {
    rpc: RpcProviderPort;
    install: CollectionExtensionInstall;
    run: {
        runId: number;
        chainId: number;
        collectionId: number;
        contract: string;
    };
};

// Returns extension-owned bootstrap artifact tasks for atomic side-lane seeding.
export type CollectionExtensionBootstrapArtifactSeedResult = {
    tasks: BootstrapCollectionExtensionArtifactTaskSeed[];
};

// Signals follow-up work needed after a collection-extension artifact refresh.
export type CollectionExtensionArtifactRefreshResult = {
    attributesChanged: boolean;
};

export interface IndexerCollectionExtension {
    key: CollectionExtensionKey;
    /** Canonical identity lets readiness distinguish token kinds without trusting host labels. */
    isMetadataReady?(target: MetadataTarget, metadata: TokenMetadata): boolean;
    /** Absolute ages for incomplete-content checks; transport recovery is independent. */
    metadataContentRetryPolicy?: MetadataContentRetryPolicy;
    /** Return confirmed present IDs at the exact anchor, never a replacement scope. */
    enumerateBootstrapTokenIds?(
        context: CollectionExtensionBootstrapEnumerationContext,
    ): Promise<string[]>;
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
