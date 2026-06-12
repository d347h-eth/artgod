import type { OpenSeaIntegrationStatus } from "@artgod/shared/config/opensea-integration";
import {
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_KEY,
} from "@artgod/shared/bootstrap/pipeline";
import { BOOTSTRAP_RUN_EVENT_CODE } from "@artgod/shared/bootstrap/run-events";
import {
    METADATA_STATS_RECOMPUTE_REASON,
    type MetadataStatsRecomputePayload,
} from "../domain/domain-jobs.js";
import type { BootstrapRunsPort } from "../ports/bootstrap-runs.js";
import type { BootstrapStepsPort } from "../ports/bootstrap-steps.js";
import {
    cleanupSuccessfulBootstrapTemporaryData,
    type BootstrapTemporaryDataCleanupResult,
    type BootstrapTemporaryDataRunsPort,
    type BootstrapTemporaryDataStoragePort,
} from "./bootstrap-temporary-data-cleanup.js";
import {
    BOOTSTRAP_BACKFILL_PLAN_KIND,
    type BootstrapBackfillPlan,
    resolveBootstrapBackfillPlan,
} from "./bootstrap-backfill-plan.js";

// Backfill executor outcomes are returned to the runtime for structured logging.
export const BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME = {
    InvalidRange: "invalid_range",
    CollectionMissing: "collection_missing",
    CompletedWithoutBackfill: "completed_without_backfill",
    BackfillQueued: "backfill_queued",
    BackfillIncomplete: "backfill_incomplete",
    BackfillCompleted: "backfill_completed",
} as const;

export type BootstrapBackfillExecutorOutcome =
    (typeof BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME)[keyof typeof BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME];

// Backfill skip reasons are persisted on bootstrap_run_steps.result_json.
export const BOOTSTRAP_BACKFILL_STEP_RESULT_REASON = {
    NoPostAnchorBlocks: "no post-anchor blocks",
} as const;

// OpenSea skip reasons are persisted on bootstrap_run_steps.result_json.
export const BOOTSTRAP_OPENSEA_STEP_RESULT_REASON = {
    IntegrationDisabled: "integration disabled",
    MissingSlug: "missing OpenSea slug",
} as const;

export type BootstrapBackfillScheduleInput = {
    chainId: number;
    runId: number;
    collectionId: number;
    address: string;
    anchorBlock: number;
    backfillBatchSize: number;
    openSeaIntegration: OpenSeaIntegrationStatus;
    traceId: string;
    sourceJobId: string;
};

export type BootstrapBackfillCheckInput = {
    chainId: number;
    runId: number;
    collectionId: number;
    address: string;
    fromBlock: number;
    toBlock: number;
    traceId: string;
    sourceJobId: string;
};

export type BootstrapBackfillScheduleResult = {
    outcome: BootstrapBackfillExecutorOutcome;
    fromBlock: number;
    anchorBlock: number;
    headBlock: number | null;
    plan: BootstrapBackfillPlan | null;
    cleanup: BootstrapTemporaryDataCleanupResult;
};

export type BootstrapBackfillCheckResult = {
    outcome: BootstrapBackfillExecutorOutcome;
    fromBlock: number;
    toBlock: number;
    expected: number;
    synced: number;
    cleanup: BootstrapTemporaryDataCleanupResult;
};

export interface BootstrapBackfillRpcPort {
    getBlockNumber(): Promise<number>;
}

export interface BootstrapBackfillCollectionPort {
    getCollection(
        chainId: number,
        collectionId: number,
    ): { openseaSlug: string | null } | null;
    markBootstrapFinished(
        chainId: number,
        collectionId: number,
        lastSyncedBlock: number,
    ): boolean;
    markOpenSeaPending(chainId: number, collectionId: number): boolean;
}

export interface BootstrapBackfillSyncProgressPort {
    countCollectionSyncedBlocksInRange(
        chainId: number,
        collectionId: number,
        fromBlock: number,
        toBlock: number,
    ): number;
}

export interface BootstrapBackfillQueuePort {
    scheduleBackfillRange(input: {
        chainId: number;
        collectionId: number;
        fromBlock: number;
        toBlock: number;
        batchSize: number;
    }): Promise<void>;
    scheduleBackfillCheck(input: {
        chainId: number;
        runId: number;
        collectionId: number;
        address: string;
        fromBlock: number;
        toBlock: number;
    }): Promise<void>;
    scheduleOpenSeaBootstrap(input: {
        chainId: number;
        runId: number;
        collectionId: number;
    }): Promise<void>;
    publishMetadataStatsRecompute(input: {
        payload: MetadataStatsRecomputePayload;
        traceId: string;
    }): Promise<void>;
}

export interface BootstrapBackfillRunsPort
    extends BootstrapTemporaryDataRunsPort,
        Pick<BootstrapRunsPort, "updateRunStatus" | "appendRunEvent"> {}

export interface BootstrapBackfillStepsPort
    extends Pick<
        BootstrapStepsPort,
        | "markStepRunning"
        | "markStepSucceeded"
        | "markStepSkipped"
        | "updateStepProgress"
    > {}

export interface BootstrapBackfillTemporaryDataPort
    extends BootstrapTemporaryDataStoragePort {}

// Executes bootstrap backfill and collection-live transitions behind testable ports.
export class BootstrapBackfillExecutor {
    constructor(
        private readonly rpcPort: BootstrapBackfillRpcPort,
        private readonly syncProgressPort: BootstrapBackfillSyncProgressPort,
        private readonly collectionPort: BootstrapBackfillCollectionPort,
        private readonly runsPort: BootstrapBackfillRunsPort,
        private readonly stepsPort: BootstrapBackfillStepsPort,
        private readonly temporaryDataPort: BootstrapBackfillTemporaryDataPort,
        private readonly queuePort: BootstrapBackfillQueuePort,
    ) {}

    async scheduleAfterSnapshot(
        input: BootstrapBackfillScheduleInput,
    ): Promise<BootstrapBackfillScheduleResult> {
        await this.maybeScheduleOpenSeaBootstrap(input);

        const fromBlock = input.anchorBlock + 1;
        if (fromBlock <= 0) {
            return {
                outcome: BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.InvalidRange,
                fromBlock,
                anchorBlock: input.anchorBlock,
                headBlock: null,
                plan: null,
                cleanup: { deleted: false },
            };
        }

        const headBlock = await this.rpcPort.getBlockNumber();
        const plan = resolveBootstrapBackfillPlan({ fromBlock, headBlock });
        if (plan.kind === BOOTSTRAP_BACKFILL_PLAN_KIND.NoPostAnchorBlocks) {
            return await this.completeWithoutBackfill(input, plan);
        }

        await this.queuePort.scheduleBackfillRange({
            chainId: input.chainId,
            collectionId: input.collectionId,
            fromBlock: plan.fromBlock,
            toBlock: plan.toBlock,
            batchSize: input.backfillBatchSize,
        });
        this.stepsPort.markStepRunning(input.runId, BOOTSTRAP_STEP_KEY.Backfill);
        this.stepsPort.updateStepProgress(input.runId, BOOTSTRAP_STEP_KEY.Backfill, {
            completed: 0,
            total: plan.totalBlocks,
        });
        this.runsPort.updateRunStatus(input.runId, BOOTSTRAP_RUN_STATUS.Backfill);
        this.runsPort.appendRunEvent({
            runId: input.runId,
            chainId: input.chainId,
            collectionId: input.collectionId,
            eventCode: BOOTSTRAP_RUN_EVENT_CODE.BackfillQueued,
            eventLevel: "info",
            message: "Bootstrap backfill queued",
            payloadJson: JSON.stringify({
                fromBlock: plan.fromBlock,
                toBlock: plan.toBlock,
            }),
        });
        await this.queuePort.scheduleBackfillCheck({
            chainId: input.chainId,
            runId: input.runId,
            collectionId: input.collectionId,
            address: input.address,
            fromBlock: plan.fromBlock,
            toBlock: plan.toBlock,
        });

        return {
            outcome: BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillQueued,
            fromBlock,
            anchorBlock: input.anchorBlock,
            headBlock,
            plan,
            cleanup: { deleted: false },
        };
    }

    async checkProgress(
        input: BootstrapBackfillCheckInput,
    ): Promise<BootstrapBackfillCheckResult> {
        const expected = input.toBlock - input.fromBlock + 1;
        if (expected <= 0) {
            return {
                outcome: BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.InvalidRange,
                fromBlock: input.fromBlock,
                toBlock: input.toBlock,
                expected,
                synced: 0,
                cleanup: { deleted: false },
            };
        }

        const synced =
            this.syncProgressPort.countCollectionSyncedBlocksInRange(
                input.chainId,
                input.collectionId,
                input.fromBlock,
                input.toBlock,
            );
        this.stepsPort.updateStepProgress(input.runId, BOOTSTRAP_STEP_KEY.Backfill, {
            completed: synced,
            total: expected,
        });
        if (synced < expected) {
            await this.queuePort.scheduleBackfillCheck({
                chainId: input.chainId,
                runId: input.runId,
                collectionId: input.collectionId,
                address: input.address,
                fromBlock: input.fromBlock,
                toBlock: input.toBlock,
            });
            return {
                outcome: BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillIncomplete,
                fromBlock: input.fromBlock,
                toBlock: input.toBlock,
                expected,
                synced,
                cleanup: { deleted: false },
            };
        }

        const updated = this.collectionPort.markBootstrapFinished(
            input.chainId,
            input.collectionId,
            input.toBlock,
        );
        if (!updated) {
            return {
                outcome: BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.CollectionMissing,
                fromBlock: input.fromBlock,
                toBlock: input.toBlock,
                expected,
                synced,
                cleanup: { deleted: false },
            };
        }

        this.stepsPort.markStepSucceeded(input.runId, BOOTSTRAP_STEP_KEY.Backfill, {
            completed: expected,
            total: expected,
        });
        this.stepsPort.markStepSucceeded(
            input.runId,
            BOOTSTRAP_STEP_KEY.CollectionLive,
        );
        this.runsPort.updateRunStatus(input.runId, BOOTSTRAP_RUN_STATUS.Completed);
        this.runsPort.appendRunEvent({
            runId: input.runId,
            chainId: input.chainId,
            collectionId: input.collectionId,
            eventCode: BOOTSTRAP_RUN_EVENT_CODE.RunCompleted,
            eventLevel: "info",
            message: "Bootstrap backfill complete; collection live",
            payloadJson: JSON.stringify({
                fromBlock: input.fromBlock,
                toBlock: input.toBlock,
            }),
        });
        const cleanup = cleanupSuccessfulBootstrapTemporaryData({
            bootstrapStorage: this.temporaryDataPort,
            bootstrapRuns: this.runsPort,
            runId: input.runId,
        });
        await this.queuePort.publishMetadataStatsRecompute({
            payload: {
                chainId: input.chainId,
                collectionId: input.collectionId,
                reason: METADATA_STATS_RECOMPUTE_REASON.BootstrapFinalized,
                sourceJobId: input.sourceJobId,
            },
            traceId: input.traceId,
        });

        return {
            outcome: BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillCompleted,
            fromBlock: input.fromBlock,
            toBlock: input.toBlock,
            expected,
            synced,
            cleanup,
        };
    }

    private async completeWithoutBackfill(
        input: BootstrapBackfillScheduleInput,
        plan: Extract<
            BootstrapBackfillPlan,
            { kind: typeof BOOTSTRAP_BACKFILL_PLAN_KIND.NoPostAnchorBlocks }
        >,
    ): Promise<BootstrapBackfillScheduleResult> {
        const updated = this.collectionPort.markBootstrapFinished(
            input.chainId,
            input.collectionId,
            input.anchorBlock,
        );
        if (!updated) {
            return {
                outcome: BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.CollectionMissing,
                fromBlock: plan.fromBlock,
                anchorBlock: input.anchorBlock,
                headBlock: plan.headBlock,
                plan,
                cleanup: { deleted: false },
            };
        }

        this.stepsPort.markStepSkipped(
            input.runId,
            BOOTSTRAP_STEP_KEY.Backfill,
            BOOTSTRAP_BACKFILL_STEP_RESULT_REASON.NoPostAnchorBlocks,
        );
        this.stepsPort.markStepSucceeded(
            input.runId,
            BOOTSTRAP_STEP_KEY.CollectionLive,
        );
        this.runsPort.updateRunStatus(input.runId, BOOTSTRAP_RUN_STATUS.Completed);
        this.runsPort.appendRunEvent({
            runId: input.runId,
            chainId: input.chainId,
            collectionId: input.collectionId,
            eventCode: BOOTSTRAP_RUN_EVENT_CODE.RunCompleted,
            eventLevel: "info",
            message: "Bootstrap completed without post-anchor backfill",
            payloadJson: JSON.stringify({
                anchorBlock: input.anchorBlock,
                head: plan.headBlock,
            }),
        });
        const cleanup = cleanupSuccessfulBootstrapTemporaryData({
            bootstrapStorage: this.temporaryDataPort,
            bootstrapRuns: this.runsPort,
            runId: input.runId,
        });
        await this.queuePort.publishMetadataStatsRecompute({
            payload: {
                chainId: input.chainId,
                collectionId: input.collectionId,
                reason: METADATA_STATS_RECOMPUTE_REASON.BootstrapFinalized,
                sourceJobId: input.sourceJobId,
            },
            traceId: input.traceId,
        });

        return {
            outcome:
                BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.CompletedWithoutBackfill,
            fromBlock: plan.fromBlock,
            anchorBlock: input.anchorBlock,
            headBlock: plan.headBlock,
            plan,
            cleanup,
        };
    }

    private async maybeScheduleOpenSeaBootstrap(
        input: BootstrapBackfillScheduleInput,
    ): Promise<void> {
        if (!input.openSeaIntegration.enabled) {
            this.markOpenSeaStepsSkipped(
                input.runId,
                BOOTSTRAP_OPENSEA_STEP_RESULT_REASON.IntegrationDisabled,
            );
            this.runsPort.appendRunEvent({
                runId: input.runId,
                chainId: input.chainId,
                collectionId: input.collectionId,
                eventCode: BOOTSTRAP_RUN_EVENT_CODE.OpenSeaSkipped,
                eventLevel: "info",
                message:
                    "OpenSea bootstrap skipped because integration is disabled",
                payloadJson: JSON.stringify({
                    reason: input.openSeaIntegration.reason,
                    missingKeys: input.openSeaIntegration.missingKeys,
                }),
            });
            return;
        }

        const collection = this.collectionPort.getCollection(
            input.chainId,
            input.collectionId,
        );
        if (!collection?.openseaSlug) {
            this.markOpenSeaStepsSkipped(
                input.runId,
                BOOTSTRAP_OPENSEA_STEP_RESULT_REASON.MissingSlug,
            );
            this.runsPort.appendRunEvent({
                runId: input.runId,
                chainId: input.chainId,
                collectionId: input.collectionId,
                eventCode: BOOTSTRAP_RUN_EVENT_CODE.OpenSeaSkipped,
                eventLevel: "info",
                message:
                    "OpenSea bootstrap skipped because no OpenSea slug is configured",
                payloadJson: null,
            });
            return;
        }

        this.collectionPort.markOpenSeaPending(input.chainId, input.collectionId);
        await this.queuePort.scheduleOpenSeaBootstrap({
            chainId: input.chainId,
            runId: input.runId,
            collectionId: input.collectionId,
        });
    }

    private markOpenSeaStepsSkipped(runId: number, reason: string): void {
        this.stepsPort.markStepSkipped(
            runId,
            BOOTSTRAP_STEP_KEY.OpenSeaIdentity,
            reason,
        );
        this.stepsPort.markStepSkipped(
            runId,
            BOOTSTRAP_STEP_KEY.OpenSeaSnapshot,
            reason,
        );
        this.stepsPort.markStepSkipped(
            runId,
            BOOTSTRAP_STEP_KEY.OpenSeaReady,
            reason,
        );
    }
}
