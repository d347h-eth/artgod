import { randomUUID } from "node:crypto";
import type { OpenSeaIntegrationStatus } from "@artgod/shared/config/opensea-integration";
import {
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_KEY,
} from "@artgod/shared/bootstrap/pipeline";
import { BOOTSTRAP_RUN_EVENT_CODE } from "@artgod/shared/bootstrap/run-events";
import type { BootstrapRunsPort } from "../ports/bootstrap-runs.js";
import type { BootstrapStepsPort } from "../ports/bootstrap-steps.js";
import type { SyncGapStorePort } from "./sync-gap-scheduler.js";
import type { OpenSeaBootstrapCollectionPayload } from "../domain/opensea-jobs.js";
import { type BootstrapTemporaryDataCleanupResult } from "./bootstrap-temporary-data-cleanup.js";
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

// Backfill step result fields hand collection-live finalization enough durable context.
export const BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD = {
    Reason: "reason",
    FromBlock: "fromBlock",
    ToBlock: "toBlock",
    LiveBlock: "liveBlock",
    Recovery: "recovery",
    RecoveryId: "recoveryId",
    RetryAt: "retryAt",
} as const;

// A slow or unavailable sync worker must not accumulate recovery work on every
// five-second progress check. Retry one missing batch at most once per minute.
export const BOOTSTRAP_BACKFILL_RECOVERY_RETRY_MS = 60_000;

type BootstrapBackfillRecovery = {
    fromBlock: number;
    toBlock: number;
    recoveryId: string;
    retryAt: number;
};

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
    backfillBatchSize: number;
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

export interface BootstrapBackfillCoverageGapPort extends Pick<
    SyncGapStorePort,
    "findGap"
> {}

export interface BootstrapBackfillQueuePort {
    scheduleBackfillRange(input: {
        chainId: number;
        collectionId: number;
        fromBlock: number;
        toBlock: number;
        batchSize: number;
        // A retained recovery identity bypasses ACKed initial-job deduplication;
        // retrying an ambiguous publication must reuse this identity.
        recoveryId?: string;
    }): Promise<void>;
    scheduleBackfillCheck(input: {
        chainId: number;
        runId: number;
        collectionId: number;
        address: string;
        fromBlock: number;
        toBlock: number;
    }): Promise<void>;
    scheduleOpenSeaBootstrap(
        input: OpenSeaBootstrapCollectionPayload,
    ): Promise<void>;
}

export interface BootstrapBackfillRunsPort extends Pick<
    BootstrapRunsPort,
    "updateRunStatus" | "appendRunEvent"
> {}

export interface BootstrapBackfillStepsPort extends Pick<
    BootstrapStepsPort,
    | "markStepRunning"
    | "markStepSucceeded"
    | "markStepSkipped"
    | "updateStepProgress"
    | "updateStepResult"
> {
    getStep(
        runId: number,
        stepKey: typeof BOOTSTRAP_STEP_KEY.Backfill,
    ): { resultJson: string | null } | null;
}

// Executes bootstrap backfill scheduling/checking and writes the collection-live handoff.
export class BootstrapBackfillExecutor {
    constructor(
        private readonly rpcPort: BootstrapBackfillRpcPort,
        private readonly syncProgressPort: BootstrapBackfillSyncProgressPort,
        private readonly collectionPort: BootstrapBackfillCollectionPort,
        private readonly runsPort: BootstrapBackfillRunsPort,
        private readonly stepsPort: BootstrapBackfillStepsPort,
        private readonly queuePort: BootstrapBackfillQueuePort,
        private readonly coverageGaps: BootstrapBackfillCoverageGapPort,
        private readonly now: () => number = Date.now,
    ) {}

    // A restarted step must resume its retained range rather than schedule a new
    // range from today's head. Explicit checks use the same execution path.
    async executeStep(
        input: BootstrapBackfillScheduleInput,
        checkRange?: { fromBlock: number; toBlock: number },
    ): Promise<BootstrapBackfillScheduleResult | BootstrapBackfillCheckResult> {
        const range =
            checkRange ??
            parseBootstrapBackfillDelegatedRange(
                this.stepsPort.getStep(input.runId, BOOTSTRAP_STEP_KEY.Backfill)
                    ?.resultJson ?? null,
            );
        return range
            ? this.checkProgress({ ...input, ...range })
            : this.scheduleAfterSnapshot(input);
    }

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
        this.stepsPort.markStepRunning(
            input.runId,
            BOOTSTRAP_STEP_KEY.Backfill,
        );
        this.stepsPort.updateStepProgress(
            input.runId,
            BOOTSTRAP_STEP_KEY.Backfill,
            {
                completed: 0,
                total: plan.totalBlocks,
            },
        );
        this.stepsPort.updateStepResult(
            input.runId,
            BOOTSTRAP_STEP_KEY.Backfill,
            buildBootstrapBackfillDelegatedStepResult({
                fromBlock: plan.fromBlock,
                toBlock: plan.toBlock,
            }),
        );
        this.runsPort.updateRunStatus(
            input.runId,
            BOOTSTRAP_RUN_STATUS.Backfill,
        );
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

        const synced = this.syncProgressPort.countCollectionSyncedBlocksInRange(
            input.chainId,
            input.collectionId,
            input.fromBlock,
            input.toBlock,
        );
        this.stepsPort.updateStepProgress(
            input.runId,
            BOOTSTRAP_STEP_KEY.Backfill,
            {
                completed: synced,
                total: expected,
            },
        );
        if (synced < expected) {
            await this.recoverMissingRange(input);
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

        this.stepsPort.markStepSucceeded(
            input.runId,
            BOOTSTRAP_STEP_KEY.Backfill,
            {
                completed: expected,
                total: expected,
            },
        );
        this.stepsPort.updateStepResult(
            input.runId,
            BOOTSTRAP_STEP_KEY.Backfill,
            buildBootstrapBackfillTerminalStepResult({
                fromBlock: input.fromBlock,
                toBlock: input.toBlock,
                liveBlock: input.toBlock,
            }),
        );

        return {
            outcome: BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillCompleted,
            fromBlock: input.fromBlock,
            toBlock: input.toBlock,
            expected,
            synced,
            cleanup: { deleted: false },
        };
    }

    private async recoverMissingRange(
        input: BootstrapBackfillCheckInput,
    ): Promise<void> {
        const retained = parseBootstrapBackfillRecovery(
            this.stepsPort.getStep(input.runId, BOOTSTRAP_STEP_KEY.Backfill)
                ?.resultJson ?? null,
            input,
        );
        const pendingGap = retained
            ? this.coverageGaps.findGap(
                  input.chainId,
                  input.collectionId,
                  retained,
                  input.backfillBatchSize,
              )
            : null;
        const now = this.now();
        if (retained && pendingGap && retained.retryAt > now) return;

        const gap =
            pendingGap ??
            this.coverageGaps.findGap(
                input.chainId,
                input.collectionId,
                input,
                input.backfillBatchSize,
            );
        if (!gap) return;
        const recovery =
            retained && pendingGap && retained.retryAt === 0
                ? retained
                : { ...gap, recoveryId: randomUUID(), retryAt: 0 };
        const saveRecovery = (pending: BootstrapBackfillRecovery) =>
            this.stepsPort.updateStepResult(
                input.runId,
                BOOTSTRAP_STEP_KEY.Backfill,
                buildBootstrapBackfillDelegatedStepResult({
                    ...input,
                    recovery: pending,
                }),
            );
        // Retain identity before publishing. A crash or uncertain broker ACK
        // retries the same delivery; a settled but still missing batch gets a
        // fresh identity after the delay so ACKed jobs cannot suppress repair.
        saveRecovery(recovery);
        await this.queuePort.scheduleBackfillRange({
            chainId: input.chainId,
            collectionId: input.collectionId,
            fromBlock: recovery.fromBlock,
            toBlock: recovery.toBlock,
            batchSize: input.backfillBatchSize,
            recoveryId: recovery.recoveryId,
        });
        saveRecovery({
            ...recovery,
            retryAt: now + BOOTSTRAP_BACKFILL_RECOVERY_RETRY_MS,
        });
    }

    private async completeWithoutBackfill(
        input: BootstrapBackfillScheduleInput,
        plan: Extract<
            BootstrapBackfillPlan,
            { kind: typeof BOOTSTRAP_BACKFILL_PLAN_KIND.NoPostAnchorBlocks }
        >,
    ): Promise<BootstrapBackfillScheduleResult> {
        this.stepsPort.markStepSkipped(
            input.runId,
            BOOTSTRAP_STEP_KEY.Backfill,
            BOOTSTRAP_BACKFILL_STEP_RESULT_REASON.NoPostAnchorBlocks,
        );
        this.stepsPort.updateStepResult(
            input.runId,
            BOOTSTRAP_STEP_KEY.Backfill,
            buildBootstrapBackfillTerminalStepResult({
                reason: BOOTSTRAP_BACKFILL_STEP_RESULT_REASON.NoPostAnchorBlocks,
                liveBlock: input.anchorBlock,
            }),
        );

        return {
            outcome:
                BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.CompletedWithoutBackfill,
            fromBlock: plan.fromBlock,
            anchorBlock: input.anchorBlock,
            headBlock: plan.headBlock,
            plan,
            cleanup: { deleted: false },
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

        this.collectionPort.markOpenSeaPending(
            input.chainId,
            input.collectionId,
        );
        await this.queuePort.scheduleOpenSeaBootstrap({
            chainId: input.chainId,
            collectionId: input.collectionId,
            bootstrap: {
                runId: input.runId,
            },
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

export type BootstrapBackfillDelegatedStepResult = {
    [BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.FromBlock]: number;
    [BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.ToBlock]: number;
    [BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.Recovery]?: BootstrapBackfillRecovery;
};

export type BootstrapBackfillTerminalStepResult = Partial<{
    [BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.Reason]: string;
    [BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.FromBlock]: number;
    [BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.ToBlock]: number;
}> & {
    [BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.LiveBlock]: number;
};

// Builds the persisted handoff state for delegated backfill health checks.
export function buildBootstrapBackfillDelegatedStepResult(input: {
    fromBlock: number;
    toBlock: number;
    recovery?: BootstrapBackfillRecovery;
}): BootstrapBackfillDelegatedStepResult {
    return {
        [BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.FromBlock]: input.fromBlock,
        [BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.ToBlock]: input.toBlock,
        ...(input.recovery
            ? {
                  [BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.Recovery]:
                      input.recovery,
              }
            : {}),
    };
}

function parseBootstrapBackfillRecovery(
    resultJson: string | null,
    range: { fromBlock: number; toBlock: number },
): BootstrapBackfillRecovery | null {
    const value =
        parseBackfillStepResult(resultJson)?.[
            BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.Recovery
        ];
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const fields = value as Record<string, unknown>;
    const fromBlock = readBackfillNumberField(
        fields,
        BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.FromBlock,
    );
    const toBlock = readBackfillNumberField(
        fields,
        BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.ToBlock,
    );
    const retryAt = readBackfillNumberField(
        fields,
        BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.RetryAt,
    );
    const recoveryId = fields[BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.RecoveryId];
    return fromBlock !== null &&
        toBlock !== null &&
        retryAt !== null &&
        fromBlock >= range.fromBlock &&
        toBlock <= range.toBlock &&
        fromBlock <= toBlock &&
        retryAt >= 0 &&
        typeof recoveryId === "string" &&
        recoveryId.length > 0
        ? { fromBlock, toBlock, recoveryId, retryAt }
        : null;
}

// Builds the persisted handoff state consumed by the collection-live step.
export function buildBootstrapBackfillTerminalStepResult(input: {
    reason?: string;
    fromBlock?: number;
    toBlock?: number;
    liveBlock: number;
}): BootstrapBackfillTerminalStepResult {
    const result: BootstrapBackfillTerminalStepResult = {
        [BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.LiveBlock]: input.liveBlock,
    };
    if (input.reason !== undefined) {
        result[BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.Reason] = input.reason;
    }
    if (input.fromBlock !== undefined) {
        result[BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.FromBlock] =
            input.fromBlock;
    }
    if (input.toBlock !== undefined) {
        result[BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.ToBlock] = input.toBlock;
    }
    return result;
}

// Reads delegated range state from bootstrap_run_steps.result_json.
export function parseBootstrapBackfillDelegatedRange(
    resultJson: string | null,
): { fromBlock: number; toBlock: number } | null {
    const parsed = parseBackfillStepResult(resultJson);
    const fromBlock = readBackfillNumberField(
        parsed,
        BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.FromBlock,
    );
    const toBlock = readBackfillNumberField(
        parsed,
        BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.ToBlock,
    );
    return fromBlock === null || toBlock === null
        ? null
        : { fromBlock, toBlock };
}

// Reads the finalized live block from bootstrap_run_steps.result_json.
export function parseBootstrapBackfillLiveBlock(
    resultJson: string | null,
): number | null {
    return readBackfillNumberField(
        parseBackfillStepResult(resultJson),
        BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.LiveBlock,
    );
}

function parseBackfillStepResult(
    resultJson: string | null,
): Record<string, unknown> | null {
    if (!resultJson) {
        return null;
    }
    try {
        const parsed = JSON.parse(resultJson) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

function readBackfillNumberField(
    parsed: Record<string, unknown> | null,
    field: string,
): number | null {
    const value = parsed?.[field];
    return Number.isInteger(value) ? Number(value) : null;
}
