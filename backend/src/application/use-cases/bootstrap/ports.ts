import type {
    ChainRecord,
    CollectionStandard,
    CollectionStatus,
    OpenSeaCollectionStatus,
} from "@artgod/shared/types";
import type {
    CollectionExtensionKey,
    EmbeddedCollectionExtensionScopeKind,
} from "@artgod/shared/extensions";
import type { ImageCacheMode } from "@artgod/shared/media/token-image-cache";
import type { BootstrapRunEventCode } from "@artgod/shared/bootstrap/run-events";
import type {
    BootstrapEnumerationMode,
    BootstrapMetadataMode,
    BootstrapMetadataTaskListItem,
    BootstrapMetadataTaskStatus,
    BootstrapRunEventRecord,
    BootstrapRunRow,
    BootstrapRunStepRecord,
    BootstrapRunStepPlan,
    BootstrapRunTaskCounts,
} from "./types.js";

export type CollectionBootstrapState = {
    chainId: number;
    collectionId: number;
    slug: string;
    address: string;
    standard: CollectionStandard;
    status: CollectionStatus;
    tokenScopeKind: EmbeddedCollectionExtensionScopeKind;
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

// BootstrapRunCreateInput is the storage contract for inserting a planned run.
export type BootstrapRunCreateInput = {
    chainId: number;
    collectionId: number;
    requestSlug: string;
    requestOpenseaSlug: string | null;
    requestAddress: string;
    requestStandard: CollectionStandard;
    imageSourceField: string;
    animationSourceField: string | null;
    requestExtensionKey: CollectionExtensionKey | null;
    metadataMode: BootstrapMetadataMode;
    enumerationMode: BootstrapEnumerationMode;
    manualTokenIdsJson: string | null;
    manualRangeStartTokenId: string | null;
    manualRangeTotalSupply: number | null;
    imageCacheMode: ImageCacheMode;
    imageCacheMaxDimension: number | null;
    deploymentBlock: number | null;
    steps: readonly BootstrapRunStepPlan[];
};

// BootstrapRunEventCreateInput is an event payload before run identifiers are attached.
export type BootstrapRunEventCreateInput = {
    eventCode: BootstrapRunEventCode;
    eventLevel: "info" | "warn" | "error";
    message: string;
    payloadJson: string | null;
};

// PreparedCollectionRunCreateInput atomically transitions a prepared row into a run.
export type PreparedCollectionRunCreateInput = BootstrapRunCreateInput & {
    requestedEvent: BootstrapRunEventCreateInput;
};

// PreparedCollectionRunAbortInput restores a prepared row after start scheduling fails.
export type PreparedCollectionRunAbortInput = {
    chainId: number;
    collectionId: number;
    runId: number;
    error: {
        code: string;
        message: string;
    };
    event: BootstrapRunEventCreateInput;
};

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
        standard: CollectionStandard;
        tokenScopeKind: EmbeddedCollectionExtensionScopeKind;
        scopeStartTokenId: string | null;
        scopeTotalSupply: number | null;
        explicitTokenIds: string[];
        deploymentBlock: number | null;
    }): CollectionBootstrapState;
    markCollectionBootstrapping(
        chainId: number,
        collectionId: number,
    ): CollectionBootstrapState | null;
    hasActiveRun(chainId: number, collectionId: number): boolean;
    createRun(input: BootstrapRunCreateInput): BootstrapRunRow;
    createPreparedCollectionRun(
        input: PreparedCollectionRunCreateInput,
    ): BootstrapRunRow;
    abortPreparedCollectionRun(input: PreparedCollectionRunAbortInput): void;
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
    getRunCollectionExtensionArtifactTaskCounts(
        runId: number,
    ): BootstrapRunTaskCounts;
    getRunOwnershipSnapshotCount(runId: number): number;
    getRunStep(
        runId: number,
        stepKey: BootstrapRunStepRecord["stepKey"],
    ): BootstrapRunStepRecord | null;
    listRunSteps(runId: number): BootstrapRunStepRecord[];
    pauseRunStep(input: {
        runId: number;
        stepKey: BootstrapRunStepRecord["stepKey"];
        expectedStatus: BootstrapRunStepRecord["status"];
    }): boolean;
    resumeRunStep(input: {
        runId: number;
        stepKey: BootstrapRunStepRecord["stepKey"];
        expectedStatus: BootstrapRunStepRecord["status"];
    }): boolean;
    retryTerminalRunStep(
        runId: number,
        stepKey: BootstrapRunStepRecord["stepKey"],
    ): {
        stepUpdated: boolean;
        taskUpdatedCount: number;
    };
    retryFailedMetadataTasks(input: {
        runId: number;
        resetImageCacheStep: boolean;
    }): {
        updatedCount: number;
        metadataStepUpdated: boolean;
        imageCacheStepReset: boolean;
        imageCacheTasksDeleted: number;
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
        standard: CollectionStandard;
        metadataMode: BootstrapMetadataMode;
        anchorBlock: number;
        anchorHash: string;
        anchorTimestamp: number;
    }): Promise<void>;
    publishBootstrapImageCacheProcess(input: {
        chainId: number;
        runId: number;
        collectionId: number;
        address: string;
        standard: CollectionStandard;
        anchorBlock: number;
        anchorHash: string;
        anchorTimestamp: number;
    }): Promise<void>;
}
