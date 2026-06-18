// Bootstrap metadata modes define how token metadata task failures affect a run.
export const BOOTSTRAP_METADATA_MODE = {
    Strict: "strict",
    BestEffort: "best_effort",
} as const;

export type BootstrapMetadataMode =
    (typeof BOOTSTRAP_METADATA_MODE)[keyof typeof BOOTSTRAP_METADATA_MODE];

// Bootstrap enumeration modes define where the planned token set comes from.
export const BOOTSTRAP_ENUMERATION_MODE = {
    Enumerable: "enumerable",
    ManualTokenIds: "manual_token_ids",
    ManualRange: "manual_range",
} as const;

export type BootstrapEnumerationMode =
    (typeof BOOTSTRAP_ENUMERATION_MODE)[keyof typeof BOOTSTRAP_ENUMERATION_MODE];

// Top-level run statuses keep legacy run-list filtering stable while steps carry detailed pipeline state.
export const BOOTSTRAP_RUN_STATUS = {
    Requested: "requested",
    Queued: "queued",
    Metadata: "metadata",
    ImageCache: "image_cache",
    Ownership: "ownership",
    Backfill: "backfill",
    Completed: "completed",
    Failed: "failed",
} as const;

export type BootstrapRunStatus =
    (typeof BOOTSTRAP_RUN_STATUS)[keyof typeof BOOTSTRAP_RUN_STATUS];

// Ordered run status list used by API parsers and storage adapters.
export const BOOTSTRAP_RUN_STATUSES = [
    BOOTSTRAP_RUN_STATUS.Requested,
    BOOTSTRAP_RUN_STATUS.Queued,
    BOOTSTRAP_RUN_STATUS.Metadata,
    BOOTSTRAP_RUN_STATUS.ImageCache,
    BOOTSTRAP_RUN_STATUS.Ownership,
    BOOTSTRAP_RUN_STATUS.Backfill,
    BOOTSTRAP_RUN_STATUS.Completed,
    BOOTSTRAP_RUN_STATUS.Failed,
] as const;

// Run statuses that still represent an active bootstrap attempt.
export const BOOTSTRAP_ACTIVE_RUN_STATUSES = [
    BOOTSTRAP_RUN_STATUS.Requested,
    BOOTSTRAP_RUN_STATUS.Queued,
    BOOTSTRAP_RUN_STATUS.Metadata,
    BOOTSTRAP_RUN_STATUS.ImageCache,
    BOOTSTRAP_RUN_STATUS.Ownership,
    BOOTSTRAP_RUN_STATUS.Backfill,
] as const;

// Pipeline step keys are persisted in bootstrap_run_steps and exposed by run detail APIs.
export const BOOTSTRAP_STEP_KEY = {
    Anchor: "anchor",
    Enumeration: "enumeration",
    Metadata: "metadata",
    Ownership: "ownership",
    Backfill: "backfill",
    CollectionLive: "collection_live",
    ImageCache: "image_cache",
    OpenSeaIdentity: "opensea_identity",
    OpenSeaSnapshot: "opensea_snapshot",
    OpenSeaReady: "opensea_ready",
    CollectionExtensionArtifacts: "collection_extension_artifacts",
} as const;

export type BootstrapStepKey =
    (typeof BOOTSTRAP_STEP_KEY)[keyof typeof BOOTSTRAP_STEP_KEY];

// Step statuses drive durable orchestration, retries, pause/resume, and read-model progress.
export const BOOTSTRAP_STEP_STATUS = {
    Pending: "pending",
    Ready: "ready",
    Running: "running",
    Paused: "paused",
    Succeeded: "succeeded",
    FailedRetry: "failed_retry",
    FailedTerminal: "failed_terminal",
    Skipped: "skipped",
} as const;

export type BootstrapStepStatus =
    (typeof BOOTSTRAP_STEP_STATUS)[keyof typeof BOOTSTRAP_STEP_STATUS];

// Ordered step status list used by storage adapters and tests.
export const BOOTSTRAP_STEP_STATUSES = [
    BOOTSTRAP_STEP_STATUS.Pending,
    BOOTSTRAP_STEP_STATUS.Ready,
    BOOTSTRAP_STEP_STATUS.Running,
    BOOTSTRAP_STEP_STATUS.Paused,
    BOOTSTRAP_STEP_STATUS.Succeeded,
    BOOTSTRAP_STEP_STATUS.FailedRetry,
    BOOTSTRAP_STEP_STATUS.FailedTerminal,
    BOOTSTRAP_STEP_STATUS.Skipped,
] as const;

// Step statuses that may still require startup reconciliation or executor wake-up.
export const BOOTSTRAP_RECOVERABLE_STEP_STATUSES = [
    BOOTSTRAP_STEP_STATUS.Pending,
    BOOTSTRAP_STEP_STATUS.Ready,
    BOOTSTRAP_STEP_STATUS.Running,
    BOOTSTRAP_STEP_STATUS.FailedRetry,
] as const;

// Step actions are the operator controls exposed by the bootstrap detail API.
export const BOOTSTRAP_STEP_ACTION = {
    Pause: "pause",
    Resume: "resume",
    Retry: "retry",
} as const;

export type BootstrapStepAction =
    (typeof BOOTSTRAP_STEP_ACTION)[keyof typeof BOOTSTRAP_STEP_ACTION];

// Steps listed here support persisted operator pause/resume controls.
export const BOOTSTRAP_PAUSABLE_STEP_KEYS = [
    BOOTSTRAP_STEP_KEY.Metadata,
    BOOTSTRAP_STEP_KEY.ImageCache,
] as const;

// Steps listed here support explicit operator recovery from terminal failure.
export const BOOTSTRAP_TERMINAL_RETRY_STEP_KEYS = [
    BOOTSTRAP_STEP_KEY.Anchor,
    BOOTSTRAP_STEP_KEY.Enumeration,
    BOOTSTRAP_STEP_KEY.Metadata,
    BOOTSTRAP_STEP_KEY.Ownership,
    BOOTSTRAP_STEP_KEY.Backfill,
    BOOTSTRAP_STEP_KEY.CollectionLive,
    BOOTSTRAP_STEP_KEY.ImageCache,
    BOOTSTRAP_STEP_KEY.OpenSeaIdentity,
    BOOTSTRAP_STEP_KEY.OpenSeaSnapshot,
    BOOTSTRAP_STEP_KEY.OpenSeaReady,
    BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts,
] as const;

// Fan-out task statuses are shared by metadata, ownership, and image-cache task tables.
export const BOOTSTRAP_TASK_STATUS = {
    Pending: "pending",
    Retry: "retry",
    Succeeded: "succeeded",
    FailedTerminal: "failed_terminal",
} as const;

export type BootstrapTaskStatus =
    (typeof BOOTSTRAP_TASK_STATUS)[keyof typeof BOOTSTRAP_TASK_STATUS];

// Ordered task status list used by API parsers and task count reducers.
export const BOOTSTRAP_TASK_STATUSES = [
    BOOTSTRAP_TASK_STATUS.Pending,
    BOOTSTRAP_TASK_STATUS.Retry,
    BOOTSTRAP_TASK_STATUS.Succeeded,
    BOOTSTRAP_TASK_STATUS.FailedTerminal,
] as const;

// Task statuses that executors may claim when next_attempt_at is due.
export const BOOTSTRAP_DUE_TASK_STATUSES = [
    BOOTSTRAP_TASK_STATUS.Pending,
    BOOTSTRAP_TASK_STATUS.Retry,
] as const;

// Flow step keys include the current queue marker plus durable pipeline steps.
export const BOOTSTRAP_FLOW_STEP_KEY = {
    Queued: "queued",
    Anchor: BOOTSTRAP_STEP_KEY.Anchor,
    Enumeration: BOOTSTRAP_STEP_KEY.Enumeration,
    Metadata: BOOTSTRAP_STEP_KEY.Metadata,
    ImageCache: BOOTSTRAP_STEP_KEY.ImageCache,
    Ownership: BOOTSTRAP_STEP_KEY.Ownership,
    Backfill: BOOTSTRAP_STEP_KEY.Backfill,
    CollectionLive: BOOTSTRAP_STEP_KEY.CollectionLive,
    OpenSeaIdentity: BOOTSTRAP_STEP_KEY.OpenSeaIdentity,
    OpenSeaSnapshot: BOOTSTRAP_STEP_KEY.OpenSeaSnapshot,
    OpenSeaReady: BOOTSTRAP_STEP_KEY.OpenSeaReady,
    CollectionExtensionArtifacts: BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts,
} as const;

export type BootstrapFlowStepKey =
    (typeof BOOTSTRAP_FLOW_STEP_KEY)[keyof typeof BOOTSTRAP_FLOW_STEP_KEY];

// Flow step states are the compact UI read-model projection of durable step status.
export const BOOTSTRAP_FLOW_STEP_STATE = {
    Pending: "pending",
    Active: "active",
    Completed: "completed",
    Failed: "failed",
} as const;

export type BootstrapFlowStepState =
    (typeof BOOTSTRAP_FLOW_STEP_STATE)[keyof typeof BOOTSTRAP_FLOW_STEP_STATE];

export type BootstrapTaskCounts = {
    pending: number;
    retry: number;
    succeeded: number;
    failedTerminal: number;
    total: number;
};

export type BootstrapTaskStatusCountRow = {
    status: string;
    count: number | bigint;
};

export type BootstrapStepDependencyRecord = {
    stepKey: BootstrapStepKey;
    status: BootstrapStepStatus;
};

export type BootstrapRunStepPlan = {
    stepKey: BootstrapStepKey;
    status: BootstrapStepStatus;
    blocking: boolean;
    dependsOn: readonly BootstrapStepKey[];
    progressTotal: number | null;
    config: Record<string, unknown> | null;
};

// Creates an empty count bucket for bootstrap fan-out task read models.
export function emptyBootstrapTaskCounts(): BootstrapTaskCounts {
    return {
        pending: 0,
        retry: 0,
        succeeded: 0,
        failedTerminal: 0,
        total: 0,
    };
}

// Reduces storage GROUP BY rows into the API count shape shared by task tables.
export function mapBootstrapTaskStatusCounts(
    rows: readonly BootstrapTaskStatusCountRow[],
): BootstrapTaskCounts {
    const counts = emptyBootstrapTaskCounts();
    for (const row of rows) {
        const value = Number(row.count) || 0;
        if (row.status === BOOTSTRAP_TASK_STATUS.Pending) {
            counts.pending = value;
        } else if (row.status === BOOTSTRAP_TASK_STATUS.Retry) {
            counts.retry = value;
        } else if (row.status === BOOTSTRAP_TASK_STATUS.Succeeded) {
            counts.succeeded = value;
        } else if (row.status === BOOTSTRAP_TASK_STATUS.FailedTerminal) {
            counts.failedTerminal = value;
        }
        counts.total += value;
    }
    return counts;
}

// Serializes step dependencies for bootstrap_run_steps.depends_on_json.
export function serializeBootstrapStepDependencies(
    dependsOn: readonly BootstrapStepKey[],
): string {
    return JSON.stringify(dependsOn);
}

// Parses persisted bootstrap_run_steps.depends_on_json into known step keys only.
export function parseBootstrapStepDependencies(
    dependsOnJson: string | null,
): BootstrapStepKey[] {
    if (!dependsOnJson) {
        return [];
    }
    try {
        const parsed = JSON.parse(dependsOnJson) as unknown;
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed.filter(isBootstrapStepKey);
    } catch {
        return [];
    }
}

// Checks values received from query strings or database rows before narrowing.
export function isBootstrapTaskStatus(
    value: unknown,
): value is BootstrapTaskStatus {
    return typeof value === "string" && taskStatusSet.has(value);
}

// Checks values received from query strings or database rows before narrowing.
export function isBootstrapRunStatus(
    value: unknown,
): value is BootstrapRunStatus {
    return typeof value === "string" && runStatusSet.has(value);
}

// Checks route/API values before narrowing them to persisted step keys.
export function isBootstrapStepKey(value: unknown): value is BootstrapStepKey {
    return typeof value === "string" && stepKeySet.has(value);
}

// Checks route/API values before narrowing them to supported step actions.
export function isBootstrapStepAction(
    value: unknown,
): value is BootstrapStepAction {
    return typeof value === "string" && stepActionSet.has(value);
}

// Owns the rule for which durable steps can be paused and resumed.
export function isBootstrapStepPausable(stepKey: BootstrapStepKey): boolean {
    return pausableStepKeySet.has(stepKey);
}

// Owns the rule for durable steps that can be manually retried after terminal failure.
export function isBootstrapStepTerminalRetryable(
    stepKey: BootstrapStepKey,
): boolean {
    return terminalRetryStepKeySet.has(stepKey);
}

// Pause is offered only while a step can still claim or retry work.
export function canPauseBootstrapStepStatus(
    status: BootstrapStepStatus,
): boolean {
    return (
        status === BOOTSTRAP_STEP_STATUS.Ready ||
        status === BOOTSTRAP_STEP_STATUS.Running ||
        status === BOOTSTRAP_STEP_STATUS.FailedRetry
    );
}

// Resume is valid only for a persisted paused step.
export function canResumeBootstrapStepStatus(
    status: BootstrapStepStatus,
): boolean {
    return status === BOOTSTRAP_STEP_STATUS.Paused;
}

// Terminal retry is an explicit operator recovery action, not a resume.
export function canRetryBootstrapStepStatus(
    status: BootstrapStepStatus,
): boolean {
    return status === BOOTSTRAP_STEP_STATUS.FailedTerminal;
}

// Wakeable steps may need an executor job after startup, resume, or dependency completion.
export function isBootstrapStepWakeableStatus(
    status: BootstrapStepStatus,
): boolean {
    return (
        status === BOOTSTRAP_STEP_STATUS.Ready ||
        status === BOOTSTRAP_STEP_STATUS.Running ||
        status === BOOTSTRAP_STEP_STATUS.FailedRetry
    );
}

// Returns true when no further work should be scheduled for the step.
export function isBootstrapStepTerminalStatus(
    status: BootstrapStepStatus,
): boolean {
    return (
        status === BOOTSTRAP_STEP_STATUS.Succeeded ||
        status === BOOTSTRAP_STEP_STATUS.FailedTerminal ||
        status === BOOTSTRAP_STEP_STATUS.Skipped
    );
}

// Returns true when a fan-out task row no longer needs executor work.
export function isBootstrapTaskTerminalStatus(
    status: BootstrapTaskStatus,
): boolean {
    return (
        status === BOOTSTRAP_TASK_STATUS.Succeeded ||
        status === BOOTSTRAP_TASK_STATUS.FailedTerminal
    );
}

// Dependency edges unblock only after the upstream step finished successfully or was intentionally skipped.
export function isBootstrapStepDependencySatisfied(
    status: BootstrapStepStatus,
): boolean {
    return (
        status === BOOTSTRAP_STEP_STATUS.Succeeded ||
        status === BOOTSTRAP_STEP_STATUS.Skipped
    );
}

// Checks whether a pending step can become ready from current dependency rows.
export function areBootstrapStepDependenciesSatisfied(
    dependsOn: readonly BootstrapStepKey[],
    records: readonly BootstrapStepDependencyRecord[],
): boolean {
    if (dependsOn.length === 0) {
        return true;
    }
    const statusByStep = new Map(
        records.map((record) => [record.stepKey, record.status]),
    );
    return dependsOn.every((stepKey) => {
        const status = statusByStep.get(stepKey);
        return status ? isBootstrapStepDependencySatisfied(status) : false;
    });
}

const taskStatusSet = new Set<string>(BOOTSTRAP_TASK_STATUSES);
const runStatusSet = new Set<string>(BOOTSTRAP_RUN_STATUSES);
const stepKeySet = new Set<string>(Object.values(BOOTSTRAP_STEP_KEY));
const stepActionSet = new Set<string>(Object.values(BOOTSTRAP_STEP_ACTION));
const pausableStepKeySet = new Set<string>(BOOTSTRAP_PAUSABLE_STEP_KEYS);
const terminalRetryStepKeySet = new Set<string>(
    BOOTSTRAP_TERMINAL_RETRY_STEP_KEYS,
);
