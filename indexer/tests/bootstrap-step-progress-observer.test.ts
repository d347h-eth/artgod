import { describe, expect, it } from "vitest";
import {
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_STEP_STATUS,
    emptyBootstrapTaskCounts,
    type BootstrapStepKey,
    type BootstrapTaskCounts,
} from "@artgod/shared/bootstrap/pipeline";
import { BootstrapStepProgressObserver } from "../src/application/bootstrap-step-progress-observer.js";
import type { BootstrapSnapshotPort } from "../src/ports/bootstrap.js";
import type { BootstrapStepRecord } from "../src/ports/bootstrap-steps.js";

describe("bootstrap step progress observer", () => {
    it("observes durable step-row progress for non-taskized steps", () => {
        const observer = new BootstrapStepProgressObserver(
            {
                getStep: () =>
                    step(BOOTSTRAP_STEP_KEY.Enumeration, {
                        completed: 42,
                        total: 100,
                    }),
            },
            taskCountsPort(),
        );

        const first = observer.observeStepProgress({
            runId: 41,
            stepKey: BOOTSTRAP_STEP_KEY.Enumeration,
        });
        const second = observer.observeStepProgress({
            runId: 41,
            stepKey: BOOTSTRAP_STEP_KEY.Enumeration,
        });

        expect(first).toEqual(
            expect.objectContaining({
                completed: 42,
                total: 100,
            }),
        );
        expect(first?.fingerprint).toBe(second?.fingerprint);
    });

    it("observes task counts for taskized bootstrap steps", () => {
        const counts = taskCounts({
            pending: 5,
            retry: 1,
            succeeded: 10,
            failedTerminal: 2,
        });
        const observer = new BootstrapStepProgressObserver(
            {
                getStep: () => step(BOOTSTRAP_STEP_KEY.Metadata),
            },
            taskCountsPort({
                getMetadataTaskCounts: () => counts,
            }),
        );

        const progress = observer.observeStepProgress({
            runId: 41,
            stepKey: BOOTSTRAP_STEP_KEY.Metadata,
        });

        expect(progress).toEqual(
            expect.objectContaining({
                completed: 12,
                total: 18,
            }),
        );
        expect(progress?.fingerprint).toContain(String(counts.pending));
        expect(progress?.fingerprint).toContain(String(counts.succeeded));
    });

    it("returns null when the step row is missing", () => {
        const observer = new BootstrapStepProgressObserver(
            {
                getStep: () => null,
            },
            taskCountsPort(),
        );

        expect(
            observer.observeStepProgress({
                runId: 41,
                stepKey: BOOTSTRAP_STEP_KEY.Metadata,
            }),
        ).toBeNull();
    });
});

function step(
    stepKey: BootstrapStepKey,
    progress: { completed: number; total: number | null } = {
        completed: 0,
        total: null,
    },
): BootstrapStepRecord {
    return {
        runId: 41,
        stepKey,
        status: BOOTSTRAP_STEP_STATUS.Running,
        blocking: true,
        dependsOn: [],
        nextAttemptAt: 0,
        leaseOwner: "test-lease",
        leaseUntil: 2_000,
        progressCompleted: progress.completed,
        progressTotal: progress.total,
        resultJson: null,
        attempts: 0,
        lastError: null,
    };
}

function taskCounts(input: {
    pending?: number;
    retry?: number;
    succeeded?: number;
    failedTerminal?: number;
}): BootstrapTaskCounts {
    const counts = emptyBootstrapTaskCounts();
    counts.pending = input.pending ?? 0;
    counts.retry = input.retry ?? 0;
    counts.succeeded = input.succeeded ?? 0;
    counts.failedTerminal = input.failedTerminal ?? 0;
    counts.total =
        counts.pending + counts.retry + counts.succeeded + counts.failedTerminal;
    return counts;
}

function taskCountsPort(
    overrides: Partial<
        Pick<
            BootstrapSnapshotPort,
            | "getMetadataTaskCounts"
            | "getImageCacheTaskCounts"
            | "getOwnershipTaskCounts"
            | "getCollectionExtensionArtifactTaskCounts"
        >
    > = {},
): Pick<
    BootstrapSnapshotPort,
    | "getMetadataTaskCounts"
    | "getImageCacheTaskCounts"
    | "getOwnershipTaskCounts"
    | "getCollectionExtensionArtifactTaskCounts"
> {
    const emptyCounts = () => emptyBootstrapTaskCounts();
    return {
        getMetadataTaskCounts:
            overrides.getMetadataTaskCounts ?? emptyCounts,
        getImageCacheTaskCounts:
            overrides.getImageCacheTaskCounts ?? emptyCounts,
        getOwnershipTaskCounts:
            overrides.getOwnershipTaskCounts ?? emptyCounts,
        getCollectionExtensionArtifactTaskCounts:
            overrides.getCollectionExtensionArtifactTaskCounts ?? emptyCounts,
    };
}
