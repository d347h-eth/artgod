import type { ChainRecord } from "@artgod/shared/types/browse";
import type { CollectionExtensionKey } from "@artgod/shared/extensions";
import type { ImageCacheMode } from "@artgod/shared/media/token-image-cache";
import type {
    BootstrapEnumerationMode,
    BootstrapMetadataMode,
    BootstrapMetadataTaskListItem,
    BootstrapMetadataTaskStatus,
    BootstrapRunEventRecord,
    BootstrapRunRow,
    BootstrapRunTaskCounts,
} from "./types.js";

type OpenSeaCollectionStatus =
    | "pending"
    | "identity_running"
    | "subscribing"
    | "snapshot_pending"
    | "snapshot_running"
    | "ready"
    | "retrying"
    | "failed";

export type CollectionBootstrapState = {
    chainId: number;
    collectionId: number;
    slug: string;
    address: string;
    standard: "erc721" | "erc1155";
    status: "bootstrapping" | "live" | "paused" | "disabled";
    tokenScopeKind:
        | "contract_all_tokens"
        | "token_range"
        | "explicit_token_ids";
    scopeStartTokenId: string | null;
    scopeTotalSupply: number | null;
    deploymentBlock: number | null;
    bootstrapAnchorBlock: number | null;
    bootstrapStartedAt: string | null;
    bootstrapFinishedAt: string | null;
    bootstrapLastSyncedBlock: number | null;
    openseaSlug: string | null;
    openseaStatus: OpenSeaCollectionStatus | null;
    openseaReadyAt: string | null;
    openseaSnapshotStartedAt: string | null;
    openseaSnapshotCompletedAt: string | null;
    openseaLastError: string | null;
};

export interface ChainRefResolverPort {
    resolveChainRef(
        chainRef: string | undefined,
        defaultPublicChainId: number,
    ): ChainRecord;
}

export interface BootstrapRunsWritePort {
    findCollectionBySlug(
        chainId: number,
        slug: string,
    ): CollectionBootstrapState | null;
    listCollectionsByAddress(
        chainId: number,
        address: string,
    ): CollectionBootstrapState[];
    listCollectionScopeTokenIds(
        chainId: number,
        collectionId: number,
    ): string[];
    resolveCollectionRef(
        chainId: number,
        collectionRef: string,
    ): CollectionBootstrapState | null;
    getCollectionById(
        chainId: number,
        collectionId: number,
    ): CollectionBootstrapState | null;
    upsertCollectionForBootstrap(input: {
        chainId: number;
        slug: string;
        address: string;
        openseaSlug: string | null;
        standard: "erc721" | "erc1155";
        tokenScopeKind:
            | "contract_all_tokens"
            | "token_range"
            | "explicit_token_ids";
        scopeStartTokenId: string | null;
        scopeTotalSupply: number | null;
        explicitTokenIds: string[];
        deploymentBlock: number | null;
    }): CollectionBootstrapState;
    hasActiveRun(chainId: number, collectionId: number): boolean;
    createRun(input: {
        chainId: number;
        collectionId: number;
        requestSlug: string;
        requestOpenseaSlug: string | null;
        requestAddress: string;
        requestStandard: "erc721" | "erc1155";
        requestExtensionKey: CollectionExtensionKey | null;
        metadataMode: BootstrapMetadataMode;
        enumerationMode: BootstrapEnumerationMode;
        manualTokenIdsJson: string | null;
        manualRangeStartTokenId: string | null;
        manualRangeTotalSupply: number | null;
        imageCacheMode: ImageCacheMode;
        imageCacheMaxDimension: number | null;
        deploymentBlock: number | null;
    }): BootstrapRunRow;
    updateRunStatus(
        runId: number,
        status: string,
        error?: { code: string; message: string } | null,
    ): void;
    appendRunEvent(input: {
        runId: number;
        chainId: number;
        collectionId: number;
        eventCode: string;
        eventLevel: "info" | "warn" | "error";
        message: string;
        payloadJson: string | null;
    }): void;
    getLatestRun(chainId: number, collectionId: number): BootstrapRunRow | null;
    getRunById(chainId: number, runId: number): BootstrapRunRow | null;
    listRunEvents(runId: number): BootstrapRunEventRecord[];
    isLatestRunForCollection(
        chainId: number,
        collectionId: number,
        runId: number,
    ): boolean;
    listRunsByChain(params: {
        chainId: number;
        status?: string;
        limit: number;
        cursorRunId?: number;
    }): {
        items: BootstrapRunRow[];
        nextCursor: string | null;
    };
    getRunTaskCounts(runId: number): BootstrapRunTaskCounts;
    getRunImageCacheTaskCounts(runId: number): BootstrapRunTaskCounts;
    getRunOwnershipSnapshotCount(runId: number): number;
    listRunMetadataTasks(params: {
        runId: number;
        status?: BootstrapMetadataTaskStatus;
        limit: number;
        cursor?: string;
    }): {
        items: BootstrapMetadataTaskListItem[];
        nextCursor: string | null;
    };
    retryFailedTasks(runId: number): number;
}

export interface BootstrapCommandQueuePort {
    publishBootstrapStart(input: {
        chainId: number;
        runId: number;
        collectionId: number;
    }): Promise<void>;
    publishBootstrapMetadataProcess(input: {
        chainId: number;
        runId: number;
        collectionId: number;
        address: string;
        standard: "erc721" | "erc1155";
        metadataMode: BootstrapMetadataMode;
        anchorBlock: number;
        anchorHash: string;
        anchorTimestamp: number;
    }): Promise<void>;
}
