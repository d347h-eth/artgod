import type {
    CollectionExtensionInstall,
    CollectionExtensionKey,
} from "@artgod/shared/extensions";
import type {
    MetadataRefreshEvent,
    MetadataRefreshRangeEvent,
} from "../../domain/onchain.js";
import type { RpcEvent, RpcLog, RpcProviderPort } from "../../ports/rpc.js";
import type {
    CollectionExtensionArtifactPort,
    CollectionExtensionInstallPort,
} from "../../ports/collection-extensions.js";
import type { MetadataFetcherPort } from "../../ports/metadata.js";

export type CollectionExtensionSyncDecodeResult = {
    metadataRefreshEvents: MetadataRefreshEvent[];
    metadataRefreshRangeEvents: MetadataRefreshRangeEvent[];
};

export type CollectionExtensionSyncWatchSpec = {
    collectionId: number;
    sourceId: string;
    address: `0x${string}` | `0x${string}`[];
    events: readonly RpcEvent[];
    decode(log: RpcLog): CollectionExtensionSyncDecodeResult;
};

export type CollectionExtensionArtifactRefreshContext = {
    rpc: RpcProviderPort;
    metadataFetcher: MetadataFetcherPort;
    installs: CollectionExtensionInstallPort;
    artifacts: CollectionExtensionArtifactPort;
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

export interface IndexerCollectionExtension {
    key: CollectionExtensionKey;
    buildSyncWatchSpecs(
        install: CollectionExtensionInstall,
    ): CollectionExtensionSyncWatchSpec[];
    refreshArtifacts(
        context: CollectionExtensionArtifactRefreshContext,
    ): Promise<void>;
}
