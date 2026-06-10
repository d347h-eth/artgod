// Bootstrap run event codes persisted in bootstrap_run_events and consumed by detail read models.
export const BOOTSTRAP_RUN_EVENT_CODE = {
    RunRequested: "run.requested",
    RunQueued: "run.queued",
    RunAnchorSelected: "run.anchor.selected",
    RunCompleted: "run.completed",
    RunFailed: "run.failed",
    StepPaused: "step.paused",
    StepResumed: "step.resumed",
    MetadataEnumerationStarted: "metadata.enumeration.started",
    MetadataEnumerationProgress: "metadata.enumeration.progress",
    MetadataEnumerationCompleted: "metadata.enumeration.completed",
    MetadataTasksSeeded: "metadata.tasks.seeded",
    MetadataQueued: "metadata.queued",
    MetadataRetryFailedTerminal: "metadata.retry.failed_terminal",
    ImageCacheQueued: "image_cache.queued",
    ImageCacheCompleted: "image_cache.completed",
    ImageCacheSkipped: "image_cache.skipped",
    BackfillQueued: "backfill.queued",
    OpenSeaSkipped: "opensea.skipped",
} as const;

export type BootstrapRunEventCode =
    (typeof BOOTSTRAP_RUN_EVENT_CODE)[keyof typeof BOOTSTRAP_RUN_EVENT_CODE];

export type BootstrapEnumerationProgressEventPayload = {
    resolved: number;
    total: number;
};

export type BootstrapEnumerationCompletedEventPayload = {
    tokenCount: number;
};

// Serializes bounded enumerable token-id progress for bootstrap detail polling.
export function serializeBootstrapEnumerationProgressEventPayload(
    payload: BootstrapEnumerationProgressEventPayload,
): string {
    return JSON.stringify(payload);
}

// Reads bounded enumerable token-id progress from bootstrap_run_events payloads.
export function parseBootstrapEnumerationProgressEventPayload(
    payloadJson: string | null,
): BootstrapEnumerationProgressEventPayload | null {
    const parsed = parsePayloadObject(payloadJson);
    if (!parsed) return null;
    const resolved = parsed.resolved;
    const total = parsed.total;
    if (!isNonNegativeInteger(resolved) || !isPositiveInteger(total)) {
        return null;
    }
    return {
        resolved: Math.min(resolved, total),
        total,
    };
}

// Reads final token-id enumeration counts from bootstrap_run_events payloads.
export function parseBootstrapEnumerationCompletedEventPayload(
    payloadJson: string | null,
): BootstrapEnumerationCompletedEventPayload | null {
    const parsed = parsePayloadObject(payloadJson);
    if (!parsed) return null;
    const tokenCount = parsed.tokenCount;
    if (!isNonNegativeInteger(tokenCount)) {
        return null;
    }
    return { tokenCount };
}

function parsePayloadObject(
    payloadJson: string | null,
): Record<string, unknown> | null {
    if (!payloadJson) return null;
    try {
        const parsed = JSON.parse(payloadJson) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
}
