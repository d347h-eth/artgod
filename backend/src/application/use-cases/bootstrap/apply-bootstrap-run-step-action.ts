import { ReadModelNotFoundError } from "@artgod/shared/read-models/errors";
import { BOOTSTRAP_RUN_EVENT_CODE } from "@artgod/shared/bootstrap/run-events";
import {
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_ACTION,
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_STEP_STATUS,
    canPauseBootstrapStepStatus,
    canRetryBootstrapStepStatus,
    canResumeBootstrapStepStatus,
    isBootstrapStepTerminalRetryable,
    isBootstrapStepPausable,
    type BootstrapRunStatus,
    type BootstrapStepAction,
    type BootstrapStepKey,
    type BootstrapStepStatus,
} from "@artgod/shared/bootstrap/pipeline";
import { BootstrapConflictError, BootstrapValidationError } from "./types.js";
import type {
    BootstrapCommandQueuePort,
    BootstrapRunsWritePort,
    ChainRefResolverPort,
} from "./ports.js";
import type { BootstrapRunRow, BootstrapRunStepRecord } from "./types.js";

export type ApplyBootstrapRunStepActionInput = {
    chainRef: string;
    runId: number;
    stepKey: BootstrapStepKey;
    action: BootstrapStepAction;
};

export type ApplyBootstrapRunStepActionOutput = {
    runId: number;
    stepKey: BootstrapStepKey;
    status: BootstrapStepStatus;
};

export class ApplyBootstrapRunStepActionUseCase {
    constructor(
        private readonly defaultChainId: number,
        private readonly chainRefResolverPort: ChainRefResolverPort,
        private readonly bootstrapRunsPort: BootstrapRunsWritePort,
        private readonly bootstrapQueuePort: BootstrapCommandQueuePort,
    ) {}

    async applyStepAction(
        input: ApplyBootstrapRunStepActionInput,
    ): Promise<ApplyBootstrapRunStepActionOutput> {
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
        if (
            !this.bootstrapRunsPort.isLatestRunForCollection(
                chain.publicChainId,
                run.collectionId,
                run.runId,
            )
        ) {
            throw new BootstrapConflictError(
                "Only latest collection run can change bootstrap steps",
            );
        }
        const step = this.bootstrapRunsPort.getRunStep(
            run.runId,
            input.stepKey,
        );
        if (!step) {
            throw new ReadModelNotFoundError("Unknown bootstrap run step");
        }

        if (input.action === BOOTSTRAP_STEP_ACTION.Retry) {
            return this.retryStep(run, step);
        }

        if (run.status === BOOTSTRAP_RUN_STATUS.Failed) {
            throw new BootstrapConflictError(
                "Run failed; retry the terminal step before pause/resume",
            );
        }
        if (!isBootstrapStepPausable(step.stepKey)) {
            throw new BootstrapValidationError(
                "Bootstrap step does not support pause/resume",
            );
        }

        if (input.action === BOOTSTRAP_STEP_ACTION.Pause) {
            return this.pauseStep(run, step);
        }

        return this.resumeStep(run, step);
    }

    private async retryStep(
        run: BootstrapRunRow,
        step: BootstrapRunStepRecord,
    ): Promise<ApplyBootstrapRunStepActionOutput> {
        if (!isBootstrapStepTerminalRetryable(step.stepKey)) {
            throw new BootstrapValidationError(
                "Bootstrap step does not support terminal retry",
            );
        }
        if (!canRetryBootstrapStepStatus(step.status)) {
            throw new BootstrapConflictError(
                "Bootstrap step cannot be retried from its current status",
            );
        }

        const retry = this.bootstrapRunsPort.retryTerminalRunStep(
            run.runId,
            step.stepKey,
        );
        if (!retry.stepUpdated) {
            throw new BootstrapConflictError(
                "Bootstrap step terminal retry lost the state race",
            );
        }

        const runStatus = resolveRunStatusAfterTerminalRetry(run, step);
        if (runStatus) {
            this.bootstrapRunsPort.updateRunStatus(run.runId, runStatus);
        }
        this.appendStepActionEvent(run, step.stepKey, BOOTSTRAP_STEP_ACTION.Retry, {
            taskUpdatedCount: retry.taskUpdatedCount,
        });
        await this.publishStepWork(run, step.stepKey);
        return buildOutput(
            run.runId,
            step.stepKey,
            BOOTSTRAP_STEP_STATUS.Ready,
        );
    }

    private pauseStep(
        run: BootstrapRunRow,
        step: BootstrapRunStepRecord,
    ): ApplyBootstrapRunStepActionOutput {
        if (step.status === BOOTSTRAP_STEP_STATUS.Paused) {
            return buildOutput(run.runId, step.stepKey, step.status);
        }
        if (!canPauseBootstrapStepStatus(step.status)) {
            throw new BootstrapConflictError(
                "Bootstrap step cannot be paused from its current status",
            );
        }

        this.bootstrapRunsPort.pauseRunStep(run.runId, step.stepKey);
        this.appendStepActionEvent(run, step.stepKey, BOOTSTRAP_STEP_ACTION.Pause);
        return buildOutput(
            run.runId,
            step.stepKey,
            BOOTSTRAP_STEP_STATUS.Paused,
        );
    }

    private async resumeStep(
        run: BootstrapRunRow,
        step: BootstrapRunStepRecord,
    ): Promise<ApplyBootstrapRunStepActionOutput> {
        if (canResumeBootstrapStepStatus(step.status)) {
            this.bootstrapRunsPort.resumeRunStep(run.runId, step.stepKey);
            this.appendStepActionEvent(
                run,
                step.stepKey,
                BOOTSTRAP_STEP_ACTION.Resume,
            );
            await this.publishStepWork(run, step.stepKey);
            return buildOutput(
                run.runId,
                step.stepKey,
                BOOTSTRAP_STEP_STATUS.Ready,
            );
        }

        if (
            step.status === BOOTSTRAP_STEP_STATUS.Ready ||
            step.status === BOOTSTRAP_STEP_STATUS.FailedRetry
        ) {
            await this.publishStepWork(run, step.stepKey);
            return buildOutput(run.runId, step.stepKey, step.status);
        }

        if (step.status === BOOTSTRAP_STEP_STATUS.Running) {
            return buildOutput(run.runId, step.stepKey, step.status);
        }

        throw new BootstrapConflictError(
            "Bootstrap step cannot be resumed from its current status",
        );
    }

    private appendStepActionEvent(
        run: BootstrapRunRow,
        stepKey: BootstrapStepKey,
        action: BootstrapStepAction,
        extraPayload: Record<string, unknown> = {},
    ): void {
        const event = resolveStepActionEvent(action);
        this.bootstrapRunsPort.appendRunEvent({
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            eventCode: event.code,
            eventLevel: "info",
            message: event.message,
            payloadJson: JSON.stringify({ stepKey, action, ...extraPayload }),
        });
    }

    private async publishStepWork(
        run: BootstrapRunRow,
        stepKey: BootstrapStepKey,
    ): Promise<void> {
        if (stepKey !== BOOTSTRAP_STEP_KEY.ImageCache) {
            await this.bootstrapQueuePort.publishBootstrapStart({
                chainId: run.chainId,
                runId: run.runId,
                collectionId: run.collectionId,
            });
            return;
        }

        assertRunAnchorReady(run);
        await this.bootstrapQueuePort.publishBootstrapImageCacheProcess(
            buildAnchoredStepPayload(run),
        );
    }
}

function resolveStepActionEvent(
    action: BootstrapStepAction,
): { code: string; message: string } {
    if (action === BOOTSTRAP_STEP_ACTION.Pause) {
        return {
            code: BOOTSTRAP_RUN_EVENT_CODE.StepPaused,
            message: "Bootstrap step paused",
        };
    }
    if (action === BOOTSTRAP_STEP_ACTION.Resume) {
        return {
            code: BOOTSTRAP_RUN_EVENT_CODE.StepResumed,
            message: "Bootstrap step resumed",
        };
    }
    return {
        code: BOOTSTRAP_RUN_EVENT_CODE.StepRetried,
        message: "Bootstrap step terminal failure retry requested",
    };
}

function resolveRunStatusAfterTerminalRetry(
    run: BootstrapRunRow,
    step: BootstrapRunStepRecord,
): BootstrapRunStatus | null {
    if (!step.blocking && run.status === BOOTSTRAP_RUN_STATUS.Completed) {
        return null;
    }
    if (
        step.stepKey === BOOTSTRAP_STEP_KEY.Anchor ||
        step.stepKey === BOOTSTRAP_STEP_KEY.Enumeration
    ) {
        return BOOTSTRAP_RUN_STATUS.Queued;
    }
    if (step.stepKey === BOOTSTRAP_STEP_KEY.Metadata) {
        return BOOTSTRAP_RUN_STATUS.Metadata;
    }
    if (step.stepKey === BOOTSTRAP_STEP_KEY.ImageCache) {
        return BOOTSTRAP_RUN_STATUS.ImageCache;
    }
    if (step.stepKey === BOOTSTRAP_STEP_KEY.Ownership) {
        return BOOTSTRAP_RUN_STATUS.Ownership;
    }
    if (
        step.stepKey === BOOTSTRAP_STEP_KEY.Backfill ||
        step.stepKey === BOOTSTRAP_STEP_KEY.CollectionLive
    ) {
        return BOOTSTRAP_RUN_STATUS.Backfill;
    }
    return run.status === BOOTSTRAP_RUN_STATUS.Failed
        ? BOOTSTRAP_RUN_STATUS.Backfill
        : null;
}

function buildAnchoredStepPayload(
    run: BootstrapRunRow & {
        anchorBlock: number;
        anchorBlockHash: string;
        anchorBlockTimestamp: number;
    },
): {
    chainId: number;
    runId: number;
    collectionId: number;
    address: string;
    standard: "erc721" | "erc1155";
    anchorBlock: number;
    anchorHash: string;
    anchorTimestamp: number;
} {
    return {
        chainId: run.chainId,
        runId: run.runId,
        collectionId: run.collectionId,
        address: run.requestAddress,
        standard: run.requestStandard,
        anchorBlock: run.anchorBlock,
        anchorHash: run.anchorBlockHash,
        anchorTimestamp: run.anchorBlockTimestamp,
    };
}

function assertRunAnchorReady(
    run: BootstrapRunRow,
): asserts run is BootstrapRunRow & {
    anchorBlock: number;
    anchorBlockHash: string;
    anchorBlockTimestamp: number;
} {
    if (
        run.anchorBlock === null ||
        !run.anchorBlockHash ||
        run.anchorBlockTimestamp === null
    ) {
        throw new BootstrapValidationError(
            "Run anchor data is incomplete; resume cannot be scheduled",
        );
    }
}

function buildOutput(
    runId: number,
    stepKey: BootstrapStepKey,
    status: BootstrapStepStatus,
): ApplyBootstrapRunStepActionOutput {
    return { runId, stepKey, status };
}
