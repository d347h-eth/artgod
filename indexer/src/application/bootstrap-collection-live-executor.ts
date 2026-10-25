import {
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_KEY,
    isBootstrapStepTerminalStatus,
} from "@artgod/shared/bootstrap/pipeline";
import { BOOTSTRAP_RUN_EVENT_CODE } from "@artgod/shared/bootstrap/run-events";
import { METADATA_STATS_RECOMPUTE_REASON } from "../domain/domain-jobs.js";
import type { BootstrapRunDefinition } from "../ports/bootstrap-runs.js";
import type { BootstrapStepRecord } from "../ports/bootstrap-steps.js";
import {
    cleanupSuccessfulBootstrapTemporaryData,
    type BootstrapTemporaryDataCleanupResult,
    type BootstrapTemporaryDataRunsPort,
    type BootstrapTemporaryDataStoragePort,
} from "./bootstrap-temporary-data-cleanup.js";
import { parseBootstrapBackfillLiveBlock } from "./bootstrap-backfill-executor.js";
import {
    bootstrapAppliedCheckpoint,
    type BootstrapAppliedProgressPort,
} from "./bootstrap-applied-progress.js";
import {
    ChainSyncConflict,
    type SyncBlockHeader,
    type ValidationCheckpoint,
} from "../domain/chain-sync.js";
import type { RpcProviderPort } from "../ports/rpc.js";
import {
    buildBootstrapFinalStatsFollowupRun,
    type MetadataRefreshFollowupRunInput,
} from "./metadata/refresh-followups.js";

// Collection-live executor outcomes are returned to runtime logs/tests.
export const BOOTSTRAP_COLLECTION_LIVE_EXECUTOR_OUTCOME = {
    Completed: "completed",
    CollectionMissing: "collection_missing",
    AwaitingAppliedProgress: "awaiting_applied_progress",
} as const;

export type BootstrapCollectionLiveExecutorOutcome =
    (typeof BOOTSTRAP_COLLECTION_LIVE_EXECUTOR_OUTCOME)[keyof typeof BOOTSTRAP_COLLECTION_LIVE_EXECUTOR_OUTCOME];

// Collection-live failure codes are stored on failed bootstrap runs.
export const BOOTSTRAP_COLLECTION_LIVE_FAILURE_CODE = {
    CollectionMissing: "collection_live_collection_missing",
} as const;

// Collection-live failure messages are persisted on step/run failure state.
export const BOOTSTRAP_COLLECTION_LIVE_FAILURE_MESSAGE = {
    MissingBackfillLiveBlock: "Backfill step did not provide live block",
    CollectionMissing: "Collection missing during live finalization",
} as const;

// Collection-live run-event payload fields are persisted for diagnostics.
export const BOOTSTRAP_COLLECTION_LIVE_EVENT_PAYLOAD_FIELD = {
    LiveBlock: "liveBlock",
    SourceJobId: "sourceJobId",
} as const;

export type BootstrapCollectionLiveInput = {
    run: BootstrapRunDefinition;
    step: BootstrapStepRecord;
    traceId: string;
    sourceJobId: string;
};

export type BootstrapCollectionLiveResult = {
    outcome: BootstrapCollectionLiveExecutorOutcome;
    liveBlock: number | null;
    cleanup: BootstrapTemporaryDataCleanupResult;
};

/** Remote observations are checked again against local ownership in one writer.
 * No bootstrap read installs canonical headers or advances accepted progress. */
export type BootstrapCollectionLiveCommit = {
    chainId: number;
    collectionId: number;
    runId: number;
    leaseOwner: string;
    lastSyncedBlock: number;
    checkpoint: ValidationCheckpoint;
    anchor: SyncBlockHeader;
    headBlock: number;
    reorgDepth: number;
    finalStats: MetadataRefreshFollowupRunInput | null;
};

export interface BootstrapCollectionLiveCollectionPort {
    /** Atomically publish collection live, successful core step and completed run.
     * Reject a replaced run, revoked lease, changed anchor or recovery checkpoint. */
    markBootstrapFinished(input: BootstrapCollectionLiveCommit): boolean;
}

export interface BootstrapCollectionLiveRunsPort extends BootstrapTemporaryDataRunsPort {
    updateRunStatus(
        runId: number,
        status: typeof BOOTSTRAP_RUN_STATUS.Failed,
        error: { code: string; message: string },
    ): void;
    appendRunEvent(input: {
        runId: number;
        chainId: number;
        collectionId: number;
        eventCode: string;
        eventLevel: "info" | "warn" | "error";
        message: string;
        payloadJson: string | null;
    }): void;
}

export interface BootstrapCollectionLiveStepsPort {
    getStep(
        runId: number,
        stepKey:
            | typeof BOOTSTRAP_STEP_KEY.Backfill
            | typeof BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts,
    ): BootstrapStepRecord | null;
    markStepFailedTerminal(input: {
        runId: number;
        stepKey: typeof BOOTSTRAP_STEP_KEY.CollectionLive;
        attempts: number;
        error: string;
    }): void;
}

export interface BootstrapCollectionLiveTemporaryDataPort extends BootstrapTemporaryDataStoragePort {}

// Finalizes collection liveness after the scheduler has terminalized backfill.
export class BootstrapCollectionLiveExecutor {
    constructor(
        private readonly collectionPort: BootstrapCollectionLiveCollectionPort,
        private readonly runsPort: BootstrapCollectionLiveRunsPort,
        private readonly stepsPort: BootstrapCollectionLiveStepsPort,
        private readonly temporaryDataPort: BootstrapCollectionLiveTemporaryDataPort,
        private readonly progress: BootstrapAppliedProgressPort,
        private readonly rpc: Pick<
            RpcProviderPort,
            "getBlockNumber" | "getBlock"
        >,
        private readonly reorgDepth: number,
    ) {
        if (!Number.isSafeInteger(reorgDepth) || reorgDepth < 0)
            throw new Error("Invalid bootstrap finalization depth");
    }

    async complete(
        input: BootstrapCollectionLiveInput,
    ): Promise<BootstrapCollectionLiveResult> {
        const backfillStep = this.stepsPort.getStep(
            input.run.runId,
            BOOTSTRAP_STEP_KEY.Backfill,
        );
        const liveBlock = parseBootstrapBackfillLiveBlock(
            backfillStep?.resultJson ?? null,
        );
        if (liveBlock === null) {
            throw new Error(
                BOOTSTRAP_COLLECTION_LIVE_FAILURE_MESSAGE.MissingBackfillLiveBlock,
            );
        }

        const checkpoint =
            input.run.anchorBlock !== null && input.run.anchorBlockHash !== null
                ? bootstrapAppliedCheckpoint(this.progress, {
                      chainId: input.run.chainId,
                      collectionId: input.run.collectionId,
                      anchorBlock: input.run.anchorBlock,
                      anchorHash: input.run.anchorBlockHash,
                  })
                : null;
        if (!checkpoint || checkpoint.block.number < liveBlock)
            return {
                outcome:
                    BOOTSTRAP_COLLECTION_LIVE_EXECUTOR_OUTCOME.AwaitingAppliedProgress,
                liveBlock,
                cleanup: { deleted: false },
            };

        const headBlock = await this.rpc.getBlockNumber();
        const anchor = await this.rpc.getBlock(input.run.anchorBlock!, {
            fresh: true,
        });
        if (
            anchor.number !== input.run.anchorBlock ||
            anchor.hash !== input.run.anchorBlockHash
        )
            throw new ChainSyncConflict(
                "Bootstrap finalization anchor changed",
            );
        if (
            headBlock < liveBlock ||
            headBlock - anchor.number < this.reorgDepth
        )
            return {
                outcome:
                    BOOTSTRAP_COLLECTION_LIVE_EXECUTOR_OUTCOME.AwaitingAppliedProgress,
                liveBlock,
                cleanup: { deleted: false },
            };
        if (!input.step.leaseOwner)
            throw new ChainSyncConflict(
                "Bootstrap finalization has no step lease",
            );

        const updated = this.collectionPort.markBootstrapFinished({
            chainId: input.run.chainId,
            collectionId: input.run.collectionId,
            runId: input.run.runId,
            leaseOwner: input.step.leaseOwner,
            lastSyncedBlock: liveBlock,
            checkpoint,
            anchor,
            headBlock,
            reorgDepth: this.reorgDepth,
            finalStats: input.run.requestExtensionKey
                ? null
                : buildBootstrapFinalStatsFollowupRun({
                      bootstrapRunId: input.run.runId,
                      chainId: input.run.chainId,
                      collectionId: input.run.collectionId,
                      statsReason:
                          METADATA_STATS_RECOMPUTE_REASON.BootstrapFinalized,
                      sourceJobId: input.sourceJobId,
                      traceId: input.traceId,
                  }),
        });
        if (!updated) {
            this.failCollectionLive(input);
            return {
                outcome:
                    BOOTSTRAP_COLLECTION_LIVE_EXECUTOR_OUTCOME.CollectionMissing,
                liveBlock,
                cleanup: { deleted: false },
            };
        }

        const cleanup = cleanupSuccessfulBootstrapTemporaryData({
            bootstrapStorage: this.temporaryDataPort,
            bootstrapRuns: this.runsPort,
            runId: input.run.runId,
            collectionExtensionArtifactsTerminal:
                isCollectionExtensionArtifactStepTerminal(
                    this.stepsPort,
                    input.run.runId,
                ),
        });
        return {
            outcome: BOOTSTRAP_COLLECTION_LIVE_EXECUTOR_OUTCOME.Completed,
            liveBlock,
            cleanup,
        };
    }

    private failCollectionLive(input: BootstrapCollectionLiveInput): void {
        this.stepsPort.markStepFailedTerminal({
            runId: input.run.runId,
            stepKey: BOOTSTRAP_STEP_KEY.CollectionLive,
            attempts: input.step.attempts + 1,
            error: BOOTSTRAP_COLLECTION_LIVE_FAILURE_MESSAGE.CollectionMissing,
        });
        this.runsPort.updateRunStatus(
            input.run.runId,
            BOOTSTRAP_RUN_STATUS.Failed,
            {
                code: BOOTSTRAP_COLLECTION_LIVE_FAILURE_CODE.CollectionMissing,
                message:
                    BOOTSTRAP_COLLECTION_LIVE_FAILURE_MESSAGE.CollectionMissing,
            },
        );
        this.runsPort.appendRunEvent({
            runId: input.run.runId,
            chainId: input.run.chainId,
            collectionId: input.run.collectionId,
            eventCode: BOOTSTRAP_RUN_EVENT_CODE.RunFailed,
            eventLevel: "error",
            message:
                BOOTSTRAP_COLLECTION_LIVE_FAILURE_MESSAGE.CollectionMissing,
            payloadJson: JSON.stringify({
                [BOOTSTRAP_COLLECTION_LIVE_EVENT_PAYLOAD_FIELD.SourceJobId]:
                    input.sourceJobId,
            }),
        });
    }
}

function isCollectionExtensionArtifactStepTerminal(
    stepsPort: BootstrapCollectionLiveStepsPort,
    runId: number,
): boolean {
    const step = stepsPort.getStep(
        runId,
        BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts,
    );
    return step ? isBootstrapStepTerminalStatus(step.status) : false;
}
