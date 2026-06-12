import {
    BOOTSTRAP_METADATA_MODE,
    BOOTSTRAP_RUN_STATUS,
    type BootstrapTaskCounts,
} from "@artgod/shared/bootstrap/pipeline";
import type { BootstrapRunDefinition } from "../ports/bootstrap-runs.js";

// Reports how many operational bootstrap rows were trimmed by a cleanup pass.
export type BootstrapTemporaryDataCleanupResult =
    | {
          deleted: false;
      }
    | {
          deleted: true;
          run: BootstrapRunDefinition;
          metadataTasks: number;
          imageCacheTasks: number;
          ownershipTasks: number;
          ownershipSnapshotRows: number;
          collectionExtensionArtifactTasks: number;
      };

// Supplies run state needed to gate cleanup to completed bootstrap runs.
export interface BootstrapTemporaryDataRunsPort {
    getRun(runId: number): BootstrapRunDefinition | null;
}

// Deletes settled operational rows while keeping terminal failures inspectable.
export interface BootstrapTemporaryDataStoragePort {
    deleteSnapshotRows(runId: number): number;
    deleteSucceededMetadataTasks(runId: number): number;
    deleteSucceededImageCacheTasks(runId: number): number;
    deleteSucceededOwnershipTasks(runId: number): number;
    deleteSucceededCollectionExtensionArtifactTasks(runId: number): number;
    getMetadataTaskCounts(runId: number): BootstrapTaskCounts;
    getImageCacheTaskCounts(runId: number): BootstrapTaskCounts;
    getOwnershipTaskCounts(runId: number): BootstrapTaskCounts;
    getCollectionExtensionArtifactTaskCounts(
        runId: number,
    ): BootstrapTaskCounts;
}

// Deletes successful operational task rows once each lane is settled.
export function cleanupSuccessfulBootstrapTemporaryData(input: {
    bootstrapStorage: BootstrapTemporaryDataStoragePort;
    bootstrapRuns: BootstrapTemporaryDataRunsPort;
    runId: number;
}): BootstrapTemporaryDataCleanupResult {
    const run = input.bootstrapRuns.getRun(input.runId);
    if (!run || run.status !== BOOTSTRAP_RUN_STATUS.Completed) {
        return { deleted: false };
    }

    const metadataCounts = input.bootstrapStorage.getMetadataTaskCounts(
        input.runId,
    );
    const imageCacheCounts = input.bootstrapStorage.getImageCacheTaskCounts(
        input.runId,
    );
    const ownershipCounts = input.bootstrapStorage.getOwnershipTaskCounts(
        input.runId,
    );
    const collectionExtensionArtifactCounts =
        input.bootstrapStorage.getCollectionExtensionArtifactTaskCounts(
            input.runId,
        );

    const metadataTasks = canDeleteMetadataSucceededTasks(run, metadataCounts)
        ? input.bootstrapStorage.deleteSucceededMetadataTasks(input.runId)
        : 0;
    const imageCacheTasks = areTaskCountsSettled(imageCacheCounts)
        ? input.bootstrapStorage.deleteSucceededImageCacheTasks(input.runId)
        : 0;
    const collectionExtensionArtifactTasks = areTaskCountsSettled(
        collectionExtensionArtifactCounts,
    )
        ? input.bootstrapStorage.deleteSucceededCollectionExtensionArtifactTasks(
              input.runId,
          )
        : 0;
    const ownershipTasks = areOwnershipTaskCountsClean(ownershipCounts)
        ? input.bootstrapStorage.deleteSucceededOwnershipTasks(input.runId)
        : 0;
    const ownershipSnapshotRows = areOwnershipTaskCountsClean(ownershipCounts)
        ? input.bootstrapStorage.deleteSnapshotRows(input.runId)
        : 0;

    if (
        metadataTasks +
            imageCacheTasks +
            ownershipTasks +
            ownershipSnapshotRows +
            collectionExtensionArtifactTasks <=
        0
    ) {
        return { deleted: false };
    }

    return {
        deleted: true,
        run,
        metadataTasks,
        imageCacheTasks,
        ownershipTasks,
        ownershipSnapshotRows,
        collectionExtensionArtifactTasks,
    };
}

function canDeleteMetadataSucceededTasks(
    run: BootstrapRunDefinition,
    counts: BootstrapTaskCounts,
): boolean {
    if (!areTaskCountsSettled(counts)) {
        return false;
    }
    return (
        counts.failedTerminal === 0 ||
        run.metadataMode === BOOTSTRAP_METADATA_MODE.BestEffort
    );
}

function areTaskCountsSettled(counts: BootstrapTaskCounts): boolean {
    return counts.pending === 0 && counts.retry === 0;
}

function areOwnershipTaskCountsClean(counts: BootstrapTaskCounts): boolean {
    return areTaskCountsSettled(counts) && counts.failedTerminal === 0;
}
