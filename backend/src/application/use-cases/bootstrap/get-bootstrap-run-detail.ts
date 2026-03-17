import { ReadModelNotFoundError } from "@artgod/shared/read-models/errors";
import type {
    BootstrapFlowStep,
    BootstrapFlowStepState,
    BootstrapRunDetailOutput,
    BootstrapRunEventRecord,
    BootstrapRunRow,
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
                events,
                isLatestForCollection,
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

function buildBootstrapRunFlow(input: {
    run: BootstrapRunRow;
    collection: CollectionBootstrapState;
    metadataTasks: BootstrapRunTaskCounts;
    events: BootstrapRunEventRecord[];
    isLatestForCollection: boolean;
}): BootstrapRunDetailOutput["flow"] {
    const eventCodes = new Set(input.events.map((event) => event.eventCode));

    const hasRequested = true;
    const hasQueued =
        eventCodes.has("run.queued") || input.run.status !== "requested";
    const hasAnchor =
        eventCodes.has("run.anchor.selected") || input.run.anchorBlock !== null;
    const hasEnumerationStarted = eventCodes.has(
        "metadata.enumeration.started",
    );
    const hasEnumerationCompleted = eventCodes.has(
        "metadata.enumeration.completed",
    );
    const hasMetadataQueued =
        eventCodes.has("metadata.queued") ||
        eventCodes.has("metadata.retry.failed_terminal");
    const hasOwnershipCompleted =
        input.run.status === "backfill" ||
        input.run.status === "completed" ||
        input.collection.status === "live";
    const hasBackfillCompleted =
        input.run.status === "completed" || input.collection.status === "live";
    const isRunFailed = input.run.status === "failed";

    const steps: BootstrapFlowStep[] = [
        {
            key: "requested",
            label: "requested",
            state: hasRequested ? "completed" : "pending",
            detailText: null,
            progress: null,
        },
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
            progress: null,
        },
        {
            key: "metadata",
            label: "metadata",
            state: resolveStepState({
                completed:
                    hasOwnershipCompleted ||
                    hasBackfillCompleted ||
                    input.collection.status === "live",
                active:
                    hasMetadataQueued &&
                    !hasOwnershipCompleted &&
                    !hasBackfillCompleted &&
                    !isRunFailed,
                failed:
                    !hasOwnershipCompleted &&
                    !hasBackfillCompleted &&
                    isRunFailed &&
                    (hasMetadataQueued || input.metadataTasks.total > 0),
            }),
            detailText: formatMetadataDetail(input.metadataTasks),
            progress:
                input.metadataTasks.total > 0
                    ? {
                          completed: input.metadataTasks.succeeded,
                          total: input.metadataTasks.total,
                      }
                    : null,
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
            progress: null,
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

    if (input.isLatestForCollection) {
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

    const shouldPoll = resolveShouldPoll(input);
    return {
        steps,
        isTerminal: !shouldPoll,
        shouldPoll,
    };
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

function formatMetadataDetail(counts: BootstrapRunTaskCounts): string | null {
    const parts: string[] = [];
    if (counts.retry > 0) {
        parts.push(`retry ${counts.retry}`);
    }
    if (counts.failedTerminal > 0) {
        parts.push(`failed ${counts.failedTerminal}`);
    }
    return parts.length > 0 ? parts.join(" / ") : null;
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
    steps: BootstrapFlowStep[],
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

    return (
        input.collection.openseaStatus !== "ready" &&
        input.collection.openseaStatus !== "failed"
    );
}
