/** Ephemeral setup output. It describes checks, never authorizes bootstrap. */
export const BOOTSTRAP_OPERATION = {
    Probe: "probe",
    Inspect: "inspect",
    Estimate: "estimate",
    Resolve: "resolve",
    Queue: "queue",
} as const;
export type BootstrapOperation =
    (typeof BOOTSTRAP_OPERATION)[keyof typeof BOOTSTRAP_OPERATION];
// Recovery messages and controls share these action names; wire operations stay stable.
export const BOOTSTRAP_ACTION_LABEL = {
    Probe: "probe contract",
    Inspect: "inspect token",
} as const;
export const BOOTSTRAP_OUTPUT_STATUS = {
    Started: "started",
    Succeeded: "succeeded",
    Completed: "completed",
    Failed: "failed",
    Skipped: "skipped",
    Retrying: "retrying",
} as const;
export const BOOTSTRAP_OUTPUT_STEP = {
    Operation: "operation",
    Observation: "observation",
    Code: "code",
    Proxy: "proxy",
    Erc721: "erc721",
    Enumerable: "enumerable",
    Name: "name",
    Supply: "supply",
    SharedContract: "shared_contract",
    Enumeration: "enumeration",
    Ownership: "ownership",
    Sample: "sample",
    TokenUri: "token_uri",
    Metadata: "metadata",
    Json: "json",
    ImageDownload: "image_download",
    ImageProcessing: "image_processing",
    OpenSea: "opensea",
    Definition: "definition",
    Scope: "scope",
    Queue: "queue",
} as const;
export type BootstrapOutput = {
    step: (typeof BOOTSTRAP_OUTPUT_STEP)[keyof typeof BOOTSTRAP_OUTPUT_STEP];
    status: (typeof BOOTSTRAP_OUTPUT_STATUS)[keyof typeof BOOTSTRAP_OUTPUT_STATUS];
    message: string;
    /** Exact public resource address. Never a configured RPC endpoint or auth header. */
    url?: string;
    /** Bounded untrusted text, displayed through the script-free JSON inspector. */
    text?: string;
};
export type BootstrapOutputReporter = (output: BootstrapOutput) => void;

export const BOOTSTRAP_STREAM_CONTENT_TYPE = "application/x-ndjson";
export const BOOTSTRAP_STREAM_RECORD = {
    Progress: "progress",
    Result: "result",
    Error: "error",
} as const;
export type BootstrapProgressRecord = BootstrapOutput & {
    type: typeof BOOTSTRAP_STREAM_RECORD.Progress;
    operation: BootstrapOperation;
    sequence: number;
    timestamp: string;
};
export type BootstrapStreamRecord<T> =
    | BootstrapProgressRecord
    | {
          type: typeof BOOTSTRAP_STREAM_RECORD.Result;
          result: T;
      }
    | {
          type: typeof BOOTSTRAP_STREAM_RECORD.Error;
          statusCode: number;
          error: string;
          message: string;
      };

// Results may carry a bounded metadata response or a source-image data URI.
export const BOOTSTRAP_STREAM_MAX_RECORD_BYTES = 96 * 1024 * 1024;
export const BOOTSTRAP_OUTPUT_MAX_ENTRIES = 400;
export const BOOTSTRAP_OUTPUT_MAX_BYTES = 12 * 1024 * 1024;
// A lost admission response cannot establish whether a run was already queued.
export const BOOTSTRAP_QUEUE_RESPONSE_UNAVAILABLE_MESSAGE =
    "Queue response unavailable. Check bootstrap runs before retrying.";

/** A callback is optional so non-streaming API and CLI consumers keep their contract. */
export async function observeBootstrapStep<T>(
    report: BootstrapOutputReporter | undefined,
    step: BootstrapOutput["step"],
    label: string,
    run: () => Promise<T>,
    describe: (value: T) => Pick<BootstrapOutput, "status" | "message">,
): Promise<T> {
    report?.({ step, status: BOOTSTRAP_OUTPUT_STATUS.Started, message: label });
    try {
        const value = await run();
        report?.({ step, ...describe(value) });
        return value;
    } catch (error) {
        report?.({
            step,
            status: BOOTSTRAP_OUTPUT_STATUS.Failed,
            message: `${label} failed. Check RPC settings and retry.`,
        });
        throw error;
    }
}
