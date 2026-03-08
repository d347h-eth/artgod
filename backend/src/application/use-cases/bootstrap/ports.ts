import type { ChainRecord } from "@artgod/shared/types/browse";
import type {
    BootstrapEnumerationMode,
    BootstrapMetadataMode,
    BootstrapMetadataTaskListItem,
    BootstrapMetadataTaskStatus,
    BootstrapRunEventRecord,
    BootstrapRunRow,
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
    slug: string | null;
    address: string;
    standard: "erc721" | "erc1155";
    status: "bootstrapping" | "live" | "paused" | "disabled";
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
    findCollectionByAddress(
        chainId: number,
        address: string,
    ): CollectionBootstrapState | null;
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
        standard: "erc721" | "erc1155";
        deploymentBlock: number | null;
    }): CollectionBootstrapState;
    hasActiveRun(chainId: number, collectionId: number): boolean;
    createRun(input: {
        chainId: number;
        collectionId: number;
        requestSlug: string;
        requestAddress: string;
        requestStandard: "erc721" | "erc1155";
        metadataMode: BootstrapMetadataMode;
        enumerationMode: BootstrapEnumerationMode;
        manualTokenIdsJson: string | null;
        manualRangeStartTokenId: string | null;
        manualRangeTotalSupply: number | null;
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
    getRunTaskCounts(runId: number): {
        pending: number;
        retry: number;
        succeeded: number;
        failedTerminal: number;
        total: number;
    };
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
