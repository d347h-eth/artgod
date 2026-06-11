import {
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_KEY,
} from "@artgod/shared/bootstrap/pipeline";
import { BOOTSTRAP_RUN_EVENT_CODE } from "@artgod/shared/bootstrap/run-events";
import {
    COLLECTION_STANDARD,
    type CollectionStandard,
} from "../domain/collections.js";
import type { BootstrapRunDefinition } from "../ports/bootstrap-runs.js";
import type { Hex, RpcBlock } from "../ports/rpc.js";
import { resolveBootstrapAnchorBlock } from "./bootstrap-anchor-plan.js";

// Anchor executor outcomes are returned to the runtime for structured logging.
export const BOOTSTRAP_ANCHOR_EXECUTOR_OUTCOME = {
    UnsupportedStandard: "unsupported_standard",
    InvalidAnchor: "invalid_anchor",
    CollectionMissing: "collection_missing",
    Anchored: "anchored",
} as const;

export type BootstrapAnchorExecutorOutcome =
    (typeof BOOTSTRAP_ANCHOR_EXECUTOR_OUTCOME)[keyof typeof BOOTSTRAP_ANCHOR_EXECUTOR_OUTCOME];

// Anchor failure codes are persisted on bootstrap_runs.error_code.
export const BOOTSTRAP_ANCHOR_FAILURE_CODE = {
    UnsupportedStandard: "unsupported_standard",
    InvalidAnchor: "invalid_anchor",
    MissingCollection: "missing_collection",
} as const;

export type BootstrapAnchorInput = {
    run: BootstrapRunDefinition;
    reorgDepth: number;
};

export type BootstrapAnchorSelection = {
    anchorBlock: number;
    anchorHash: Hex;
    anchorTimestamp: number;
};

export type BootstrapAnchorExecutorResult =
    | {
          outcome:
              | typeof BOOTSTRAP_ANCHOR_EXECUTOR_OUTCOME.UnsupportedStandard
              | typeof BOOTSTRAP_ANCHOR_EXECUTOR_OUTCOME.InvalidAnchor
              | typeof BOOTSTRAP_ANCHOR_EXECUTOR_OUTCOME.CollectionMissing;
          run: BootstrapRunDefinition;
          anchor: BootstrapAnchorSelection | null;
      }
    | {
          outcome: typeof BOOTSTRAP_ANCHOR_EXECUTOR_OUTCOME.Anchored;
          run: BootstrapRunDefinition;
          anchor: BootstrapAnchorSelection;
      };

export interface BootstrapAnchorRpcPort {
    getBlockNumber(): Promise<number>;
    getBlock(blockNumber: number): Promise<RpcBlock>;
}

export interface BootstrapAnchorRunsPort {
    updateRunStatus(
        runId: number,
        status: typeof BOOTSTRAP_RUN_STATUS.Failed | typeof BOOTSTRAP_RUN_STATUS.Metadata,
        error?: { code: string; message: string } | null,
    ): void;
    updateRunAnchor(input: {
        runId: number;
        anchorBlock: number;
        anchorHash: string;
        anchorTimestamp: number;
    }): void;
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

export interface BootstrapAnchorStepsPort {
    markStepRunning(runId: number, stepKey: typeof BOOTSTRAP_STEP_KEY.Anchor): void;
    markStepSucceeded(
        runId: number,
        stepKey: typeof BOOTSTRAP_STEP_KEY.Anchor,
    ): void;
    markStepFailedTerminal(input: {
        runId: number;
        stepKey: typeof BOOTSTRAP_STEP_KEY.Anchor;
        attempts: number;
        error: string;
    }): void;
}

export interface BootstrapAnchorCollectionPort {
    markBootstrapStarted(
        chainId: number,
        collectionId: number,
        anchorBlock: number,
    ): boolean;
}

// Selects and persists the settled bootstrap anchor before token enumeration.
export class BootstrapAnchorExecutor {
    constructor(
        private readonly rpcPort: BootstrapAnchorRpcPort,
        private readonly runsPort: BootstrapAnchorRunsPort,
        private readonly stepsPort: BootstrapAnchorStepsPort,
        private readonly collectionPort: BootstrapAnchorCollectionPort,
    ) {}

    async anchor(input: BootstrapAnchorInput): Promise<BootstrapAnchorExecutorResult> {
        const { run } = input;
        if (!isBootstrapAnchorSupportedStandard(run.requestStandard)) {
            this.runsPort.updateRunStatus(run.runId, BOOTSTRAP_RUN_STATUS.Failed, {
                code: BOOTSTRAP_ANCHOR_FAILURE_CODE.UnsupportedStandard,
                message: `Unsupported standard: ${run.requestStandard}`,
            });
            this.runsPort.appendRunEvent({
                runId: run.runId,
                chainId: run.chainId,
                collectionId: run.collectionId,
                eventCode: BOOTSTRAP_RUN_EVENT_CODE.RunFailed,
                eventLevel: "error",
                message: "Unsupported standard for bootstrap",
                payloadJson: JSON.stringify({ standard: run.requestStandard }),
            });
            return {
                outcome: BOOTSTRAP_ANCHOR_EXECUTOR_OUTCOME.UnsupportedStandard,
                run,
                anchor: null,
            };
        }

        this.stepsPort.markStepRunning(run.runId, BOOTSTRAP_STEP_KEY.Anchor);
        const anchorBlock = resolveBootstrapAnchorBlock({
            headBlock: await this.rpcPort.getBlockNumber(),
            reorgDepth: input.reorgDepth,
        });
        if (anchorBlock === null) {
            const message = "Anchor block is invalid";
            this.stepsPort.markStepFailedTerminal({
                runId: run.runId,
                stepKey: BOOTSTRAP_STEP_KEY.Anchor,
                attempts: 1,
                error: message,
            });
            this.runsPort.updateRunStatus(run.runId, BOOTSTRAP_RUN_STATUS.Failed, {
                code: BOOTSTRAP_ANCHOR_FAILURE_CODE.InvalidAnchor,
                message,
            });
            return {
                outcome: BOOTSTRAP_ANCHOR_EXECUTOR_OUTCOME.InvalidAnchor,
                run,
                anchor: null,
            };
        }

        const block = await this.rpcPort.getBlock(anchorBlock);
        const anchor = {
            anchorBlock,
            anchorHash: block.hash,
            anchorTimestamp: block.timestamp,
        };
        this.runsPort.updateRunAnchor({
            runId: run.runId,
            anchorBlock,
            anchorHash: anchor.anchorHash,
            anchorTimestamp: anchor.anchorTimestamp,
        });
        this.runsPort.updateRunStatus(run.runId, BOOTSTRAP_RUN_STATUS.Metadata);
        this.stepsPort.markStepSucceeded(run.runId, BOOTSTRAP_STEP_KEY.Anchor);
        this.runsPort.appendRunEvent({
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            eventCode: BOOTSTRAP_RUN_EVENT_CODE.RunAnchorSelected,
            eventLevel: "info",
            message: "Bootstrap anchor selected",
            payloadJson: JSON.stringify({
                anchorBlock,
                anchorHash: anchor.anchorHash,
                anchorTimestamp: anchor.anchorTimestamp,
            }),
        });

        const updated = this.collectionPort.markBootstrapStarted(
            run.chainId,
            run.collectionId,
            anchorBlock,
        );
        if (!updated) {
            this.runsPort.updateRunStatus(run.runId, BOOTSTRAP_RUN_STATUS.Failed, {
                code: BOOTSTRAP_ANCHOR_FAILURE_CODE.MissingCollection,
                message: "Collection row is missing",
            });
            return {
                outcome: BOOTSTRAP_ANCHOR_EXECUTOR_OUTCOME.CollectionMissing,
                run,
                anchor,
            };
        }

        return {
            outcome: BOOTSTRAP_ANCHOR_EXECUTOR_OUTCOME.Anchored,
            run,
            anchor,
        };
    }
}

function isBootstrapAnchorSupportedStandard(
    standard: CollectionStandard,
): boolean {
    return standard === COLLECTION_STANDARD.Erc721;
}
