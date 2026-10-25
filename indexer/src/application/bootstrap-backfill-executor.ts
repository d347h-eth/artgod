import {
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_KEY,
} from "@artgod/shared/bootstrap/pipeline";
import { BOOTSTRAP_RUN_EVENT_CODE } from "@artgod/shared/bootstrap/run-events";
import type { BootstrapRunsPort } from "../ports/bootstrap-runs.js";
import type { BootstrapStepsPort } from "../ports/bootstrap-steps.js";
import { type BootstrapTemporaryDataCleanupResult } from "./bootstrap-temporary-data-cleanup.js";
import {
    bootstrapAppliedCheckpoint,
    type BootstrapAppliedBase,
    type BootstrapAppliedProgressPort,
} from "./bootstrap-applied-progress.js";
import {
    BOOTSTRAP_BACKFILL_PLAN_KIND,
    type BootstrapBackfillPlan,
    resolveBootstrapBackfillPlan,
} from "./bootstrap-backfill-plan.js";

// Backfill executor outcomes are returned to the runtime for structured logging.
export const BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME = {
    InvalidRange: "invalid_range",
    LeaseLost: "lease_lost",
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
    BaseRetryAt: "baseRetryAt",
} as const;

export type BootstrapBackfillClaim = BootstrapAppliedBase & {
    runId: number;
    address: string;
    leaseOwner: string;
};

export type BootstrapBackfillScheduleInput = BootstrapBackfillClaim & {
    traceId: string;
    sourceJobId: string;
};

export type BootstrapBackfillCheckInput = BootstrapBackfillClaim & {
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

export interface BootstrapBackfillQueuePort {
    scheduleBackfillRange(input: {
        chainId: number;
        collectionId: number;
        fromBlock: number;
        toBlock: number;
    }): Promise<void>;
    scheduleBackfillCheck(input: {
        chainId: number;
        runId: number;
        collectionId: number;
        address: string;
        fromBlock: number;
        toBlock: number;
    }): Promise<void>;
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
    /** Recheck current run, anchor and unexpired claim inside one writer, then
     * execute only synchronous persistence work. A stale claim writes nothing. */
    commitBackfillStep(
        claim: BootstrapBackfillClaim,
        write: () => void,
    ): boolean;
    getStep(
        runId: number,
        stepKey: typeof BOOTSTRAP_STEP_KEY.Backfill,
    ): { resultJson: string | null } | null;
}

// Executes bootstrap backfill scheduling/checking and writes the collection-live handoff.
export class BootstrapBackfillExecutor {
    constructor(
        private readonly rpcPort: BootstrapBackfillRpcPort,
        private readonly syncProgressPort: BootstrapAppliedProgressPort,
        private readonly runsPort: BootstrapBackfillRunsPort,
        private readonly stepsPort: BootstrapBackfillStepsPort,
        private readonly queuePort: BootstrapBackfillQueuePort,
    ) {}

    // A restarted step must resume its retained range rather than schedule a new
    // range from today's head. Explicit checks use the same execution path.
    async executeStep(
        input: BootstrapBackfillScheduleInput,
        checkRange?: { fromBlock: number; toBlock: number },
    ): Promise<BootstrapBackfillScheduleResult | BootstrapBackfillCheckResult> {
        const range =
            parseBootstrapBackfillDelegatedRange(
                this.stepsPort.getStep(input.runId, BOOTSTRAP_STEP_KEY.Backfill)
                    ?.resultJson ?? null,
            ) ?? checkRange;
        return range
            ? this.checkProgress({ ...input, ...range })
            : this.scheduleAfterSnapshot(input);
    }

    async scheduleAfterSnapshot(
        input: BootstrapBackfillScheduleInput,
    ): Promise<BootstrapBackfillScheduleResult | BootstrapBackfillCheckResult> {
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
        const toBlock =
            plan.kind === BOOTSTRAP_BACKFILL_PLAN_KIND.NoPostAnchorBlocks
                ? input.anchorBlock
                : plan.toBlock;
        const retained: {
            range: { fromBlock: number; toBlock: number } | null;
        } = { range: null };
        let completedWithoutBackfill = false;
        const committed = this.stepsPort.commitBackfillStep(input, () => {
            retained.range = parseBootstrapBackfillDelegatedRange(
                this.stepsPort.getStep(input.runId, BOOTSTRAP_STEP_KEY.Backfill)
                    ?.resultJson ?? null,
            );
            if (retained.range) return;
            if (
                plan.kind === BOOTSTRAP_BACKFILL_PLAN_KIND.NoPostAnchorBlocks &&
                bootstrapAppliedCheckpoint(this.syncProgressPort, input)
            ) {
                this.completeWithoutBackfill(input);
                completedWithoutBackfill = true;
                return;
            }
            this.stepsPort.markStepRunning(
                input.runId,
                BOOTSTRAP_STEP_KEY.Backfill,
            );
            this.stepsPort.updateStepProgress(
                input.runId,
                BOOTSTRAP_STEP_KEY.Backfill,
                {
                    completed: 0,
                    total: toBlock - fromBlock + 1,
                },
            );
            // The phase, first target and event form one durable delegation.
            // A crash cannot publish only part of the coordinator handoff.
            this.runsPort.updateRunStatus(
                input.runId,
                BOOTSTRAP_RUN_STATUS.Backfill,
            );
            this.stepsPort.updateStepResult(
                input.runId,
                BOOTSTRAP_STEP_KEY.Backfill,
                buildBootstrapBackfillDelegatedStepResult({
                    fromBlock: plan.fromBlock,
                    toBlock,
                }),
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
                    toBlock,
                }),
            });
        });
        if (!committed || completedWithoutBackfill)
            return {
                outcome: committed
                    ? BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.CompletedWithoutBackfill
                    : BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.LeaseLost,
                fromBlock,
                anchorBlock: input.anchorBlock,
                headBlock,
                plan,
                cleanup: { deleted: false },
            };
        if (retained.range)
            return this.checkProgress({ ...input, ...retained.range });
        // The retained range describes completion, not independent acquisition.
        // This queue delivery is only a wakeup; periodic coordination survives
        // a lost wakeup and owns all missing post-anchor application.
        if (toBlock >= fromBlock)
            await this.queuePort.scheduleBackfillRange({
                chainId: input.chainId,
                collectionId: input.collectionId,
                fromBlock,
                toBlock,
            });
        await this.queuePort.scheduleBackfillCheck({
            chainId: input.chainId,
            runId: input.runId,
            collectionId: input.collectionId,
            address: input.address,
            fromBlock: plan.fromBlock,
            toBlock,
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
        if (expected < 0 || input.fromBlock !== input.anchorBlock + 1) {
            return {
                outcome: BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.InvalidRange,
                fromBlock: input.fromBlock,
                toBlock: input.toBlock,
                expected,
                synced: 0,
                cleanup: { deleted: false },
            };
        }

        let synced = 0;
        let complete = false;
        const committed = this.stepsPort.commitBackfillStep(input, () => {
            const retained = parseBootstrapBackfillDelegatedRange(
                this.stepsPort.getStep(input.runId, BOOTSTRAP_STEP_KEY.Backfill)
                    ?.resultJson ?? null,
            );
            // A delayed queue check cannot substitute another completion target.
            if (
                retained &&
                (retained.fromBlock !== input.fromBlock ||
                    retained.toBlock !== input.toBlock)
            )
                return;
            const checkpoint = bootstrapAppliedCheckpoint(
                this.syncProgressPort,
                input,
            );
            synced = checkpoint
                ? Math.max(
                      0,
                      Math.min(input.toBlock, checkpoint.block.number) -
                          input.fromBlock +
                          1,
                  )
                : 0;
            this.stepsPort.updateStepProgress(
                input.runId,
                BOOTSTRAP_STEP_KEY.Backfill,
                {
                    completed: synced,
                    total: expected,
                },
            );
            complete = !!checkpoint && checkpoint.block.number >= input.toBlock;
            if (!complete) return;
            const result = buildBootstrapBackfillTerminalStepResult({
                fromBlock: input.fromBlock,
                toBlock: input.toBlock,
                liveBlock: input.toBlock,
            });
            if (expected === 0)
                this.stepsPort.markStepSkipped(
                    input.runId,
                    BOOTSTRAP_STEP_KEY.Backfill,
                    BOOTSTRAP_BACKFILL_STEP_RESULT_REASON.NoPostAnchorBlocks,
                    result,
                );
            else
                this.stepsPort.markStepSucceeded(
                    input.runId,
                    BOOTSTRAP_STEP_KEY.Backfill,
                    { completed: expected, total: expected },
                    result,
                );
        });
        if (!committed || !complete) {
            if (committed)
                await this.queuePort.scheduleBackfillCheck({
                    chainId: input.chainId,
                    runId: input.runId,
                    collectionId: input.collectionId,
                    address: input.address,
                    fromBlock: input.fromBlock,
                    toBlock: input.toBlock,
                });
            return {
                outcome: committed
                    ? BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillIncomplete
                    : BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.LeaseLost,
                fromBlock: input.fromBlock,
                toBlock: input.toBlock,
                expected,
                synced,
                cleanup: { deleted: false },
            };
        }

        return {
            outcome: BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillCompleted,
            fromBlock: input.fromBlock,
            toBlock: input.toBlock,
            expected,
            synced,
            cleanup: { deleted: false },
        };
    }

    private completeWithoutBackfill(
        input: BootstrapBackfillScheduleInput,
    ): void {
        this.stepsPort.markStepSkipped(
            input.runId,
            BOOTSTRAP_STEP_KEY.Backfill,
            BOOTSTRAP_BACKFILL_STEP_RESULT_REASON.NoPostAnchorBlocks,
            buildBootstrapBackfillTerminalStepResult({
                reason: BOOTSTRAP_BACKFILL_STEP_RESULT_REASON.NoPostAnchorBlocks,
                fromBlock: input.anchorBlock + 1,
                toBlock: input.anchorBlock,
                liveBlock: input.anchorBlock,
            }),
        );
    }
}

export type BootstrapBackfillDelegatedStepResult = {
    [BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.FromBlock]: number;
    [BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.ToBlock]: number;
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
}): BootstrapBackfillDelegatedStepResult {
    return {
        [BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.FromBlock]: input.fromBlock,
        [BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.ToBlock]: input.toBlock,
    };
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
