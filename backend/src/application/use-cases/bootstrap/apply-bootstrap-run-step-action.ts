import { ReadModelNotFoundError } from "@artgod/shared/read-models/errors";
import { BOOTSTRAP_RUN_EVENT_CODE } from "@artgod/shared/bootstrap/run-events";
import {
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_ACTION,
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_STEP_STATUS,
    canPauseBootstrapStepStatus,
    canResumeBootstrapStepStatus,
    isBootstrapStepPausable,
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
        if (run.status === BOOTSTRAP_RUN_STATUS.Failed) {
            throw new BootstrapConflictError(
                "Run failed fatally; queue a new bootstrap run",
            );
        }
        const step = this.bootstrapRunsPort.getRunStep(
            run.runId,
            input.stepKey,
        );
        if (!step) {
            throw new ReadModelNotFoundError("Unknown bootstrap run step");
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
            await this.publishResumeWork(run, step.stepKey);
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
            await this.publishResumeWork(run, step.stepKey);
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
    ): void {
        this.bootstrapRunsPort.appendRunEvent({
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            eventCode:
                action === BOOTSTRAP_STEP_ACTION.Pause
                    ? BOOTSTRAP_RUN_EVENT_CODE.StepPaused
                    : BOOTSTRAP_RUN_EVENT_CODE.StepResumed,
            eventLevel: "info",
            message:
                action === BOOTSTRAP_STEP_ACTION.Pause
                    ? "Bootstrap step paused"
                    : "Bootstrap step resumed",
            payloadJson: JSON.stringify({ stepKey, action }),
        });
    }

    private async publishResumeWork(
        run: BootstrapRunRow,
        stepKey: BootstrapStepKey,
    ): Promise<void> {
        assertRunAnchorReady(run);
        if (stepKey === BOOTSTRAP_STEP_KEY.Metadata) {
            await this.bootstrapQueuePort.publishBootstrapMetadataProcess({
                chainId: run.chainId,
                runId: run.runId,
                collectionId: run.collectionId,
                address: run.requestAddress,
                standard: run.requestStandard,
                metadataMode: run.metadataMode,
                anchorBlock: run.anchorBlock,
                anchorHash: run.anchorBlockHash,
                anchorTimestamp: run.anchorBlockTimestamp,
            });
            return;
        }

        await this.bootstrapQueuePort.publishBootstrapImageCacheProcess({
            chainId: run.chainId,
            runId: run.runId,
            collectionId: run.collectionId,
            address: run.requestAddress,
            standard: run.requestStandard,
            anchorBlock: run.anchorBlock,
            anchorHash: run.anchorBlockHash,
            anchorTimestamp: run.anchorBlockTimestamp,
        });
    }
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
