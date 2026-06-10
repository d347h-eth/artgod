import { ReadModelNotFoundError } from "@artgod/shared/read-models/errors";
import type { OpenSeaIntegrationStatus } from "@artgod/shared/config/opensea-integration";
import { isImageCachePolicyActive } from "@artgod/shared/media/token-image-cache";
import {
    BOOTSTRAP_RUN_EVENT_CODE,
    parseBootstrapEnumerationCompletedEventPayload,
    parseBootstrapEnumerationProgressEventPayload,
} from "@artgod/shared/bootstrap/run-events";
import {
    BOOTSTRAP_FLOW_STEP_KEY,
    BOOTSTRAP_FLOW_STEP_STATE,
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_ACTION,
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_STEP_STATUS,
    canPauseBootstrapStepStatus,
    canResumeBootstrapStepStatus,
    isBootstrapStepKey,
    isBootstrapStepPausable,
    isBootstrapStepTerminalStatus,
    type BootstrapFlowStepKey,
} from "@artgod/shared/bootstrap/pipeline";
import type {
    BootstrapFlowStep,
    BootstrapFlowStepState,
    BootstrapRunDetailOutput,
    BootstrapRunEventRecord,
    BootstrapRunRow,
    BootstrapRunStepRecord,
    BootstrapRunTaskCounts,
} from "./types.js";
import type {
    BootstrapRunsWritePort,
    ChainRefResolverPort,
    CollectionBootstrapState,
} from "./ports.js";

export type GetBootstrapRunDetailInput = {
    chainRef: string;
    runId: number;
};

const FAILED_TASKS_PREVIEW_LIMIT = 50;

export class GetBootstrapRunDetailUseCase {
    constructor(
        private readonly defaultChainId: number,
        private readonly openseaIntegration: OpenSeaIntegrationStatus,
        private readonly chainRefResolverPort: ChainRefResolverPort,
        private readonly bootstrapRunsPort: BootstrapRunsWritePort,
    ) {}

    getRunDetail(input: GetBootstrapRunDetailInput): BootstrapRunDetailOutput {
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        const run = this.bootstrapRunsPort.getRunById(
            chain.publicChainId,
            input.runId,
        );
        if (!run) {
            throw new ReadModelNotFoundError("Unknown bootstrap run");
        }

        const collection = this.bootstrapRunsPort.getCollectionById(
            chain.publicChainId,
            run.collectionId,
        );
        if (!collection) {
            throw new ReadModelNotFoundError(
                "Unknown collection for bootstrap run",
            );
        }

        const counts = this.bootstrapRunsPort.getRunTaskCounts(run.runId);
        const imageCacheCounts =
            this.bootstrapRunsPort.getRunImageCacheTaskCounts(run.runId);
        const ownershipSnapshotCount =
            this.bootstrapRunsPort.getRunOwnershipSnapshotCount(run.runId);
        const runSteps = this.bootstrapRunsPort.listRunSteps(run.runId);
        const events = this.bootstrapRunsPort.listRunEvents(run.runId);
        const isLatestForCollection =
            this.bootstrapRunsPort.isLatestRunForCollection(
                chain.publicChainId,
                run.collectionId,
                run.runId,
            );
        const failedTasksPreview = this.bootstrapRunsPort.listRunMetadataTasks({
            runId: run.runId,
            status: "failed_terminal",
            limit: FAILED_TASKS_PREVIEW_LIMIT,
        });

        return {
            run,
            collection: mapCollectionSummary(collection),
            metadataTasks: counts,
            flow: buildBootstrapRunFlow({
                run,
                collection,
                metadataTasks: counts,
                imageCacheTasks: imageCacheCounts,
                ownershipSnapshotCount,
                runSteps,
                events,
                isLatestForCollection,
                openseaIntegration: this.openseaIntegration,
            }),
            failedMetadataTasksPreview: failedTasksPreview.items,
            failedMetadataTasksPreviewLimit: FAILED_TASKS_PREVIEW_LIMIT,
            isLatestForCollection,
        };
    }
}

function mapCollectionSummary(collection: CollectionBootstrapState): {
    chainId: number;
    collectionId: number;
    slug: string;
    address: string;
    status: "bootstrapping" | "live" | "paused" | "disabled";
} {
    return {
        chainId: collection.chainId,
        collectionId: collection.collectionId,
        slug: collection.slug,
        address: collection.address,
        status: collection.status,
    };
}

type BootstrapFlowStepDraft = Omit<
    BootstrapFlowStep,
    "blocking" | "pausable" | "paused" | "availableActions"
> &
    Partial<
        Pick<
            BootstrapFlowStep,
            "blocking" | "pausable" | "paused" | "availableActions"
        >
    >;

function buildBootstrapRunFlow(input: {
    run: BootstrapRunRow;
    collection: CollectionBootstrapState;
    metadataTasks: BootstrapRunTaskCounts;
    imageCacheTasks: BootstrapRunTaskCounts;
    ownershipSnapshotCount: number;
    runSteps: BootstrapRunStepRecord[];
    events: BootstrapRunEventRecord[];
    isLatestForCollection: boolean;
    openseaIntegration: OpenSeaIntegrationStatus;
}): BootstrapRunDetailOutput["flow"] {
    if (input.runSteps.length > 0) {
        return buildBootstrapRunFlowFromSteps(input);
    }

    const eventCodes = new Set(input.events.map((event) => event.eventCode));

    const hasRequested = true;
    const hasQueued =
        eventCodes.has(BOOTSTRAP_RUN_EVENT_CODE.RunQueued) ||
        input.run.status !== "requested";
    const hasAnchor =
        eventCodes.has(BOOTSTRAP_RUN_EVENT_CODE.RunAnchorSelected) ||
        input.run.anchorBlock !== null;
    const hasEnumerationStarted = eventCodes.has(
        BOOTSTRAP_RUN_EVENT_CODE.MetadataEnumerationStarted,
    );
    const hasEnumerationCompleted = eventCodes.has(
        BOOTSTRAP_RUN_EVENT_CODE.MetadataEnumerationCompleted,
    );
    const hasMetadataQueued =
        eventCodes.has(BOOTSTRAP_RUN_EVENT_CODE.MetadataQueued) ||
        eventCodes.has(BOOTSTRAP_RUN_EVENT_CODE.MetadataRetryFailedTerminal);
    const hasMetadataCompleted =
        input.run.status === "image_cache" ||
        input.run.status === "ownership" ||
        input.run.status === "backfill" ||
        input.run.status === "completed" ||
        input.collection.status === "live";
    const hasImageCacheQueued =
        eventCodes.has(BOOTSTRAP_RUN_EVENT_CODE.ImageCacheQueued) ||
        eventCodes.has(BOOTSTRAP_RUN_EVENT_CODE.ImageCacheCompleted) ||
        eventCodes.has(BOOTSTRAP_RUN_EVENT_CODE.ImageCacheSkipped);
    const hasImageCacheCompleted =
        hasMetadataCompleted &&
        (!isImageCacheRunActive(input.run) ||
            eventCodes.has(BOOTSTRAP_RUN_EVENT_CODE.ImageCacheCompleted) ||
            eventCodes.has(BOOTSTRAP_RUN_EVENT_CODE.ImageCacheSkipped) ||
            input.run.status === "ownership" ||
            input.run.status === "backfill" ||
            input.run.status === "completed" ||
            input.collection.status === "live");
    const hasOwnershipCompleted =
        input.run.status === "backfill" ||
        input.run.status === "completed" ||
        input.collection.status === "live";
    const hasBackfillCompleted =
        input.run.status === "completed" || input.collection.status === "live";
    const isRunFailed = input.run.status === "failed";
    const enumerationProgress = resolveEnumerationProgress(input.events);
    const metadataProgress = resolveTaskProgress(input.metadataTasks);
    const imageCacheProgress = isImageCacheRunActive(input.run)
        ? resolveTaskProgress(input.imageCacheTasks)
        : null;
    const ownershipProgress = resolveOwnershipProgress({
        run: input.run,
        metadataTasks: input.metadataTasks,
        ownershipSnapshotCount: input.ownershipSnapshotCount,
        hasOwnershipCompleted,
    });

    const steps: BootstrapFlowStepDraft[] = [
        {
            key: "queued",
            label: "queued",
            state: resolveStepState({
                completed: hasQueued,
                active: !hasQueued && hasRequested,
                failed: false,
            }),
            detailText: null,
            progress: null,
        },
        {
            key: "anchor",
            label: "anchor",
            state: resolveStepState({
                completed: hasAnchor,
                active: hasQueued && !hasAnchor && !isRunFailed,
                failed: !hasAnchor && isRunFailed,
            }),
            detailText:
                input.run.anchorBlock !== null
                    ? `block ${input.run.anchorBlock}`
                    : null,
            progress: null,
        },
        {
            key: "enumeration",
            label: "enumeration",
            state: resolveStepState({
                completed: hasEnumerationCompleted,
                active:
                    hasEnumerationStarted &&
                    !hasEnumerationCompleted &&
                    !isRunFailed,
                failed:
                    !hasEnumerationCompleted &&
                    isRunFailed &&
                    (hasAnchor || hasEnumerationStarted),
            }),
            detailText: null,
            progress: enumerationProgress,
        },
        {
            key: "metadata",
            label: "metadata",
            state: resolveStepState({
                completed: hasMetadataCompleted,
                active:
                    hasMetadataQueued && !hasMetadataCompleted && !isRunFailed,
                failed:
                    !hasMetadataCompleted &&
                    isRunFailed &&
                    (hasMetadataQueued || input.metadataTasks.total > 0),
            }),
            detailText: formatMetadataDetail(input.metadataTasks),
            progress: metadataProgress,
        },
        {
            key: "image_cache",
            label: "image cache",
            state: resolveStepState({
                completed: hasImageCacheCompleted,
                active: input.run.status === "image_cache" && !isRunFailed,
                failed:
                    !hasImageCacheCompleted &&
                    isRunFailed &&
                    (hasImageCacheQueued || hasMetadataCompleted),
            }),
            detailText: formatImageCacheDetail(
                input.run,
                input.imageCacheTasks,
            ),
            progress: imageCacheProgress,
        },
        {
            key: "ownership",
            label: "ownership",
            state: resolveStepState({
                completed: hasOwnershipCompleted,
                active: input.run.status === "ownership" && !isRunFailed,
                failed:
                    !hasOwnershipCompleted &&
                    isRunFailed &&
                    (hasMetadataQueued || input.metadataTasks.total > 0),
            }),
            detailText: null,
            progress: ownershipProgress,
        },
        {
            key: "backfill",
            label: "backfill",
            state: resolveStepState({
                completed: hasBackfillCompleted,
                active: input.run.status === "backfill" && !isRunFailed,
                failed: input.run.status === "failed" && hasOwnershipCompleted,
            }),
            detailText: null,
            progress: null,
        },
        {
            key: "collection_live",
            label: "collection live",
            state: resolveStepState({
                completed: input.collection.status === "live",
                active: false,
                failed: false,
            }),
            detailText: null,
            progress: null,
        },
    ];

    if (shouldTrackOpenSeaFlow(input)) {
        const openseaIdentityCompleted = Boolean(input.collection.openseaSlug);
        const openseaSnapshotCompleted =
            input.collection.openseaSnapshotCompletedAt !== null ||
            input.collection.openseaReadyAt !== null ||
            input.collection.openseaStatus === "ready";
        const openseaReadyCompleted =
            input.collection.openseaReadyAt !== null ||
            input.collection.openseaStatus === "ready";
        const openseaIdentityActive =
            input.collection.openseaStatus === "identity_running" ||
            (input.collection.openseaStatus === "retrying" &&
                !openseaIdentityCompleted);
        const openseaSnapshotActive =
            input.collection.openseaStatus === "subscribing" ||
            input.collection.openseaStatus === "snapshot_running" ||
            (input.collection.openseaStatus === "retrying" &&
                openseaIdentityCompleted &&
                !openseaSnapshotCompleted);
        const openseaFailed = input.collection.openseaStatus === "failed";

        steps.push(
            {
                key: "opensea_identity",
                label: "opensea identity",
                state: resolveStepState({
                    completed: openseaIdentityCompleted,
                    active: openseaIdentityActive,
                    failed: openseaFailed && !openseaIdentityCompleted,
                }),
                detailText: input.collection.openseaSlug,
                progress: null,
            },
            {
                key: "opensea_snapshot",
                label: "opensea snapshot",
                state: resolveStepState({
                    completed: openseaSnapshotCompleted,
                    active: openseaSnapshotActive,
                    failed:
                        openseaFailed &&
                        openseaIdentityCompleted &&
                        !openseaSnapshotCompleted,
                }),
                detailText: formatOpenSeaSnapshotDetail(input.collection),
                progress: null,
            },
            {
                key: "opensea_ready",
                label: "opensea ready",
                state: resolveStepState({
                    completed: openseaReadyCompleted,
                    active: false,
                    failed:
                        openseaFailed &&
                        openseaIdentityCompleted &&
                        openseaSnapshotCompleted &&
                        !openseaReadyCompleted,
                }),
                detailText: null,
                progress: null,
            },
        );
    }

    if (isRunFailed) {
        applyRunFailureDetail(
            steps,
            input.run.errorMessage ?? input.run.errorCode ?? "bootstrap failed",
        );
    }

    const shouldPoll =
        resolveShouldPoll(input) ||
        shouldPollNonBlockingSteps(input.runSteps);
    return {
        steps: finalizeBootstrapFlowSteps(steps),
        isTerminal: !shouldPoll,
        shouldPoll,
    };
}

function buildBootstrapRunFlowFromSteps(
    input: Parameters<typeof buildBootstrapRunFlow>[0],
): BootstrapRunDetailOutput["flow"] {
    const queuedCompleted = input.run.status !== BOOTSTRAP_RUN_STATUS.Requested;
    const steps: BootstrapFlowStepDraft[] = [
        {
            key: BOOTSTRAP_FLOW_STEP_KEY.Queued,
            label: "queued",
            state: resolveStepState({
                completed: queuedCompleted,
                active: !queuedCompleted,
                failed: false,
            }),
            detailText: null,
            progress: null,
            blocking: true,
        },
    ];

    for (const step of input.runSteps) {
        const key = step.stepKey as BootstrapFlowStepKey;
        steps.push({
            key,
            label: formatBootstrapStepLabel(key),
            state: resolveFlowStepStateFromStepStatus(step.status),
            detailText: formatPersistedStepDetail(input, step),
            progress: resolvePersistedStepProgress(step),
            blocking: step.blocking,
            pausable: isPausableBootstrapStep(key),
            paused: step.status === BOOTSTRAP_STEP_STATUS.Paused,
            availableActions: resolveBootstrapStepActions(key, step.status),
        });
    }

    if (input.run.status === BOOTSTRAP_RUN_STATUS.Failed) {
        applyRunFailureDetail(
            steps,
            input.run.errorMessage ?? input.run.errorCode ?? "bootstrap failed",
        );
    }

    const shouldPoll =
        resolveShouldPoll(input) ||
        shouldPollNonBlockingSteps(input.runSteps);
    return {
        steps: finalizeBootstrapFlowSteps(steps),
        isTerminal: !shouldPoll,
        shouldPoll,
    };
}

function shouldTrackOpenSeaFlow(input: {
    collection: CollectionBootstrapState;
    isLatestForCollection: boolean;
    openseaIntegration: OpenSeaIntegrationStatus;
}): boolean {
    if (!input.isLatestForCollection || !input.openseaIntegration.enabled) {
        return false;
    }
    return Boolean(
        input.collection.openseaSlug || input.collection.openseaStatus,
    );
}

function resolveStepState(input: {
    completed: boolean;
    active: boolean;
    failed: boolean;
}): BootstrapFlowStepState {
    if (input.failed) return "failed";
    if (input.completed) return "completed";
    if (input.active) return "active";
    return "pending";
}

function resolveFlowStepStateFromStepStatus(
    status: BootstrapRunStepRecord["status"],
): BootstrapFlowStepState {
    if (status === BOOTSTRAP_STEP_STATUS.FailedTerminal) {
        return BOOTSTRAP_FLOW_STEP_STATE.Failed;
    }
    if (
        status === BOOTSTRAP_STEP_STATUS.Succeeded ||
        status === BOOTSTRAP_STEP_STATUS.Skipped
    ) {
        return BOOTSTRAP_FLOW_STEP_STATE.Completed;
    }
    if (
        status === BOOTSTRAP_STEP_STATUS.Ready ||
        status === BOOTSTRAP_STEP_STATUS.Running ||
        status === BOOTSTRAP_STEP_STATUS.Paused ||
        status === BOOTSTRAP_STEP_STATUS.FailedRetry
    ) {
        return BOOTSTRAP_FLOW_STEP_STATE.Active;
    }
    return BOOTSTRAP_FLOW_STEP_STATE.Pending;
}

function resolvePersistedStepProgress(
    step: BootstrapRunStepRecord,
): BootstrapFlowStep["progress"] {
    if (step.progressTotal === null) {
        return null;
    }
    return normalizeProgress(step.progressCompleted, step.progressTotal);
}

function formatPersistedStepDetail(
    input: Parameters<typeof buildBootstrapRunFlow>[0],
    step: BootstrapRunStepRecord,
): string | null {
    if (step.lastError) {
        return step.lastError;
    }
    if (step.stepKey === BOOTSTRAP_STEP_KEY.Metadata) {
        return formatMetadataDetail(input.metadataTasks);
    }
    if (step.stepKey === BOOTSTRAP_STEP_KEY.ImageCache) {
        return formatImageCacheDetail(input.run, input.imageCacheTasks);
    }
    return null;
}

function formatBootstrapStepLabel(key: BootstrapFlowStepKey): string {
    switch (key) {
        case BOOTSTRAP_FLOW_STEP_KEY.Anchor:
            return "anchor";
        case BOOTSTRAP_FLOW_STEP_KEY.Enumeration:
            return "enumeration";
        case BOOTSTRAP_FLOW_STEP_KEY.Metadata:
            return "metadata";
        case BOOTSTRAP_FLOW_STEP_KEY.ImageCache:
            return "image cache";
        case BOOTSTRAP_FLOW_STEP_KEY.Ownership:
            return "ownership";
        case BOOTSTRAP_FLOW_STEP_KEY.Backfill:
            return "backfill";
        case BOOTSTRAP_FLOW_STEP_KEY.CollectionLive:
            return "collection live";
        case BOOTSTRAP_FLOW_STEP_KEY.OpenSeaIdentity:
            return "opensea identity";
        case BOOTSTRAP_FLOW_STEP_KEY.OpenSeaSnapshot:
            return "opensea snapshot";
        case BOOTSTRAP_FLOW_STEP_KEY.OpenSeaReady:
            return "opensea ready";
        case BOOTSTRAP_FLOW_STEP_KEY.CollectionExtensionArtifacts:
            return "extension artifacts";
        case BOOTSTRAP_FLOW_STEP_KEY.Queued:
            return "queued";
    }
}

function isPausableBootstrapStep(key: BootstrapFlowStepKey): boolean {
    return isBootstrapStepKey(key) && isBootstrapStepPausable(key);
}

function resolveBootstrapStepActions(
    key: BootstrapFlowStepKey,
    status: BootstrapRunStepRecord["status"],
): BootstrapFlowStep["availableActions"] {
    if (!isPausableBootstrapStep(key)) {
        return [];
    }
    if (canResumeBootstrapStepStatus(status)) {
        return [BOOTSTRAP_STEP_ACTION.Resume];
    }
    if (canPauseBootstrapStepStatus(status)) {
        return [BOOTSTRAP_STEP_ACTION.Pause];
    }
    return [];
}

function finalizeBootstrapFlowSteps(
    steps: BootstrapFlowStepDraft[],
): BootstrapFlowStep[] {
    return steps.map((step) => {
        const pausable =
            step.pausable ?? isPausableBootstrapStep(step.key);
        const paused = step.paused ?? false;
        return {
            ...step,
            blocking: step.blocking ?? true,
            pausable,
            paused,
            availableActions: step.availableActions ?? [],
        };
    });
}

function resolveTaskProgress(
    counts: BootstrapRunTaskCounts,
): BootstrapFlowStep["progress"] {
    return normalizeProgress(
        counts.succeeded + counts.failedTerminal,
        counts.total,
    );
}

function resolveEnumerationProgress(
    events: BootstrapRunEventRecord[],
): BootstrapFlowStep["progress"] {
    let progress: BootstrapFlowStep["progress"] = null;
    for (const event of events) {
        if (
            event.eventCode ===
            BOOTSTRAP_RUN_EVENT_CODE.MetadataEnumerationProgress
        ) {
            const payload = parseBootstrapEnumerationProgressEventPayload(
                event.payloadJson,
            );
            if (payload) {
                progress = normalizeProgress(payload.resolved, payload.total);
            }
        }
        if (
            event.eventCode ===
            BOOTSTRAP_RUN_EVENT_CODE.MetadataEnumerationCompleted
        ) {
            const payload = parseBootstrapEnumerationCompletedEventPayload(
                event.payloadJson,
            );
            if (payload) {
                progress = normalizeProgress(
                    payload.tokenCount,
                    payload.tokenCount,
                );
            }
        }
    }
    return progress;
}

function resolveOwnershipProgress(input: {
    run: BootstrapRunRow;
    metadataTasks: BootstrapRunTaskCounts;
    ownershipSnapshotCount: number;
    hasOwnershipCompleted: boolean;
}): BootstrapFlowStep["progress"] {
    if (input.run.status !== "ownership" && !input.hasOwnershipCompleted) {
        return null;
    }
    return normalizeProgress(
        input.ownershipSnapshotCount,
        input.metadataTasks.total,
    );
}

function normalizeProgress(
    completed: number,
    total: number,
): BootstrapFlowStep["progress"] {
    if (!Number.isFinite(total) || total <= 0) {
        return null;
    }
    const normalizedTotal = Math.max(0, Math.trunc(total));
    if (normalizedTotal <= 0) {
        return null;
    }
    const normalizedCompleted = Math.min(
        normalizedTotal,
        Math.max(0, Math.trunc(completed)),
    );
    return {
        completed: normalizedCompleted,
        total: normalizedTotal,
    };
}

function formatMetadataDetail(counts: BootstrapRunTaskCounts): string | null {
    return formatTaskDetail(counts);
}

function formatTaskDetail(counts: BootstrapRunTaskCounts): string | null {
    const parts: string[] = [];
    if (counts.retry > 0) {
        parts.push(`retry ${counts.retry}`);
    }
    if (counts.failedTerminal > 0) {
        parts.push(`failed ${counts.failedTerminal}`);
    }
    return parts.length > 0 ? parts.join(" / ") : null;
}

function formatImageCacheDetail(
    run: BootstrapRunRow,
    counts: BootstrapRunTaskCounts,
): string | null {
    if (!isImageCacheRunActive(run)) {
        return "disabled";
    }
    const taskDetail = formatTaskDetail(counts);
    if (run.imageCacheMaxDimension === null) {
        return ["original", taskDetail].filter(Boolean).join(" / ");
    }
    return [`${run.imageCacheMaxDimension}px`, taskDetail]
        .filter(Boolean)
        .join(" / ");
}

function isImageCacheRunActive(run: BootstrapRunRow): boolean {
    return isImageCachePolicyActive({
        imageCacheMode: run.imageCacheMode,
        maxDimension: run.imageCacheMaxDimension,
    });
}

function formatOpenSeaSnapshotDetail(
    collection: CollectionBootstrapState,
): string | null {
    if (collection.openseaStatus === "retrying") {
        return collection.openseaLastError
            ? `retrying: ${collection.openseaLastError}`
            : "retrying";
    }
    if (collection.openseaStatus === "subscribing") {
        return "subscribing";
    }
    if (collection.openseaStatus === "snapshot_running") {
        return "running";
    }
    if (collection.openseaStatus === "failed") {
        return collection.openseaLastError ?? "failed";
    }
    return null;
}

function applyRunFailureDetail(
    steps: BootstrapFlowStepDraft[],
    failureMessage: string,
): void {
    for (let index = steps.length - 1; index >= 0; index -= 1) {
        if (steps[index]?.state !== "failed") continue;
        steps[index] = {
            ...steps[index]!,
            detailText: failureMessage,
        };
        return;
    }
}

function resolveShouldPoll(input: {
    run: BootstrapRunRow;
    collection: CollectionBootstrapState;
    isLatestForCollection: boolean;
    openseaIntegration: OpenSeaIntegrationStatus;
}): boolean {
    if (input.run.status === "failed") {
        return false;
    }

    if (input.run.status !== "completed") {
        return true;
    }

    if (!input.isLatestForCollection) {
        return false;
    }

    if (!shouldTrackOpenSeaFlow(input)) {
        return false;
    }

    return (
        input.collection.openseaStatus !== "ready" &&
        input.collection.openseaStatus !== "failed"
    );
}

function shouldPollNonBlockingSteps(
    steps: readonly BootstrapRunStepRecord[],
): boolean {
    return steps.some(
        (step) =>
            !step.blocking &&
            step.status !== BOOTSTRAP_STEP_STATUS.Paused &&
            !isBootstrapStepTerminalStatus(step.status),
    );
}
