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

export type BootstrapStatusOutput = {
    collection: {
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
