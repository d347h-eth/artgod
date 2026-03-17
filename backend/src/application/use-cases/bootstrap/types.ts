import type { ChainRecord } from "@artgod/shared/types/browse";

export type BootstrapMetadataMode = "strict" | "best_effort";

export type BootstrapEnumerationMode =
    | "enumerable"
    | "manual_token_ids"
    | "manual_range";

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
    deploymentBlock?: number;
};

export type CreateBootstrapRunOutput = {
    runId: number;
    collectionId: number;
    status: string;
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
    metadataMode: BootstrapMetadataMode;
    enumerationMode: BootstrapEnumerationMode;
    manualTokenIdsJson: string | null;
    manualRangeStartTokenId: string | null;
    manualRangeTotalSupply: number | null;
    deploymentBlock: number | null;
    status: string;
    anchorBlock: number | null;
    anchorBlockHash: string | null;
    anchorBlockTimestamp: number | null;
    errorCode: string | null;
    errorMessage: string | null;
    createdAt: string;
    updatedAt: string;
    finishedAt: string | null;
};

export type BootstrapMetadataTaskStatus =
    | "pending"
    | "retry"
    | "succeeded"
    | "failed_terminal";

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

export type BootstrapRunStatus =
    | "requested"
    | "queued"
    | "metadata"
    | "ownership"
    | "backfill"
    | "completed"
    | "failed";

export type BootstrapRunTaskCounts = {
    pending: number;
    retry: number;
    succeeded: number;
    failedTerminal: number;
    total: number;
};

export type BootstrapFlowStepKey =
    | "requested"
    | "queued"
    | "anchor"
    | "enumeration"
    | "metadata"
    | "ownership"
    | "backfill"
    | "collection_live"
    | "opensea_identity"
    | "opensea_snapshot"
    | "opensea_ready";

export type BootstrapFlowStepState =
    | "pending"
    | "active"
    | "completed"
    | "failed";

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
