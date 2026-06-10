import type { ChainRecord } from "@artgod/shared/types/browse";
import type { CollectionExtensionKey } from "@artgod/shared/extensions";
import type { ImageCacheMode } from "@artgod/shared/media/token-image-cache";
import type { CollectionCustomizationSourceKind } from "@artgod/shared/types";
import type {
    BootstrapEnumerationMode,
    BootstrapFlowStepKey,
    BootstrapFlowStepState,
    BootstrapMetadataMode,
    BootstrapRunStatus,
    BootstrapTaskCounts,
    BootstrapTaskStatus,
} from "@artgod/shared/bootstrap/pipeline";

export type {
    BootstrapEnumerationMode,
    BootstrapFlowStepKey,
    BootstrapFlowStepState,
    BootstrapMetadataMode,
    BootstrapRunStatus,
} from "@artgod/shared/bootstrap/pipeline";

export type BootstrapManualInput =
    | {
          mode: "manual_token_ids";
          tokenIds: string[];
      }
    | {
          mode: "manual_range";
          startTokenId: string;
          totalSupply: number;
      };

export type CreateBootstrapRunInput = {
    chainRef: string;
    slug: string;
    address: string;
    openseaSlug?: string;
    standard: "erc721";
    metadataMode: BootstrapMetadataMode;
    supportsEnumerable: boolean;
    manualInput?: BootstrapManualInput;
    imageCache?: {
        selectedSource: CollectionCustomizationSourceKind;
        imageCacheMode: ImageCacheMode;
        maxDimension: number | null;
    };
    deploymentBlock?: number;
};

export type CreateBootstrapRunOutput = {
    runId: number;
    collectionId: number;
    status: BootstrapRunStatus;
    createdAt: string;
};

export type BootstrapRunRow = {
    runId: number;
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
    status: BootstrapRunStatus;
    anchorBlock: number | null;
    anchorBlockHash: string | null;
    anchorBlockTimestamp: number | null;
    errorCode: string | null;
    errorMessage: string | null;
    createdAt: string;
    updatedAt: string;
    finishedAt: string | null;
};

export type BootstrapMetadataTaskStatus = BootstrapTaskStatus;

export type BootstrapMetadataTaskListItem = {
    tokenId: string;
    status: BootstrapMetadataTaskStatus;
    attempts: number;
    nextAttemptAt: number;
    lastError: string | null;
    lastErrorAt: number | null;
};

export type BootstrapRunEventRecord = {
    eventCode: string;
    eventLevel: "info" | "warn" | "error";
    message: string;
    createdAt: string;
    payloadJson: string | null;
};

export type BootstrapRunTaskCounts = BootstrapTaskCounts;

export type BootstrapFlowStep = {
    key: BootstrapFlowStepKey;
    label: string;
    state: BootstrapFlowStepState;
    detailText: string | null;
    progress: {
        completed: number;
        total: number;
    } | null;
};

export type BootstrapRunFlow = {
    steps: BootstrapFlowStep[];
    isTerminal: boolean;
    shouldPoll: boolean;
};

export type BootstrapRunCollectionSummary = {
    chainId: number;
    collectionId: number;
    slug: string;
    address: string;
    status: "bootstrapping" | "live" | "paused" | "disabled";
};

export type BootstrapRunListItem = {
    run: BootstrapRunRow;
    collection: BootstrapRunCollectionSummary;
    metadataTasks: BootstrapRunTaskCounts;
};

export type ListBootstrapRunsOutput = {
    chain: ChainRecord;
    filters: {
        status?: BootstrapRunStatus;
    };
    page: {
        items: BootstrapRunListItem[];
        nextCursor: string | null;
        limit: number;
    };
};

export type BootstrapRunDetailOutput = {
    run: BootstrapRunRow;
    collection: BootstrapRunCollectionSummary;
    metadataTasks: BootstrapRunTaskCounts;
    flow: BootstrapRunFlow;
    failedMetadataTasksPreview: BootstrapMetadataTaskListItem[];
    failedMetadataTasksPreviewLimit: number;
    isLatestForCollection: boolean;
};

export type BootstrapStatusOutput = {
    collection: {
        chainId: number;
        collectionId: number;
        slug: string;
        address: string;
        standard: "erc721" | "erc1155";
        status: "bootstrapping" | "live" | "paused" | "disabled";
        deploymentBlock: number | null;
        bootstrapAnchorBlock: number | null;
        bootstrapStartedAt: string | null;
        bootstrapFinishedAt: string | null;
        bootstrapLastSyncedBlock: number | null;
    };
    latestRun: BootstrapRunRow | null;
    metadataTasks: {
        pending: number;
        retry: number;
        succeeded: number;
        failedTerminal: number;
        total: number;
    };
};

export class BootstrapConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BootstrapConflictError";
    }
}

export class BootstrapValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BootstrapValidationError";
    }
}
