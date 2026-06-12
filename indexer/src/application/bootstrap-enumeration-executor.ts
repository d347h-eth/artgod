import { logger } from "@artgod/shared/utils";
import {
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_KEY,
    type BootstrapStepKey,
} from "@artgod/shared/bootstrap/pipeline";
import {
    BOOTSTRAP_RUN_EVENT_CODE,
    serializeBootstrapEnumerationProgressEventPayload,
} from "@artgod/shared/bootstrap/run-events";
import { COLLECTION_STANDARD } from "../domain/collections.js";
import type { BootstrapMetadataTaskSeed } from "../ports/bootstrap.js";
import type { BootstrapRunDefinition } from "../ports/bootstrap-runs.js";
import type { Hex } from "../ports/rpc.js";

// Enumeration progress is persisted every N resolved ids to keep event volume bounded.
export const BOOTSTRAP_ENUMERATION_PROGRESS_EVENT_STEP = 1_000;

// Metadata seed progress logs are bounded so large collections do not spam logs.
export const BOOTSTRAP_METADATA_TASK_SEED_LOG_STEP = 10_000;

// Enumeration executor outcomes are returned to the runtime for diagnostics.
export const BOOTSTRAP_ENUMERATION_EXECUTOR_OUTCOME = {
    MetadataQueued: "metadata_queued",
} as const;

// Enumeration failure codes are persisted on bootstrap_runs.error_code.
export const BOOTSTRAP_ENUMERATION_FAILURE_CODE = {
    BootstrapStartFailed: "bootstrap_start_failed",
} as const;

// Log component/action names keep enumeration observability queryable.
export const BOOTSTRAP_ENUMERATION_EXECUTOR_LOG = {
    Component: "BootstrapEnumerationExecutor",
    Action: "execute",
} as const;

export type BootstrapEnumerationExecutorOutcome =
    (typeof BOOTSTRAP_ENUMERATION_EXECUTOR_OUTCOME)[keyof typeof BOOTSTRAP_ENUMERATION_EXECUTOR_OUTCOME];

export type BootstrapEnumerationAnchor = {
    anchorBlock: number;
    anchorHash: Hex;
    anchorTimestamp: number;
};

export type BootstrapEnumerationInput = {
    run: BootstrapRunDefinition;
    anchor: BootstrapEnumerationAnchor;
    metadataBatchSize: number;
    traceId: string;
};

export type BootstrapEnumerationExecutorResult = {
    outcome: typeof BOOTSTRAP_ENUMERATION_EXECUTOR_OUTCOME.MetadataQueued;
    tokenCount: number;
    elapsedMs: number;
};

export interface BootstrapEnumerationResolverPort {
    resolveTokenIds(input: {
        run: BootstrapRunDefinition;
        anchorBlock: number;
        onProgress: (progress: {
            resolved: number;
            total: number | null;
        }) => void;
    }): Promise<string[]>;
}

export interface BootstrapEnumerationStoragePort {
    resetSnapshot(runId: number): void;
    resetMetadataTasks(runId: number): void;
    resetImageCacheTasks(runId: number): void;
    resetOwnershipTasks(runId: number): void;
    insertMetadataTasks(rows: BootstrapMetadataTaskSeed[]): void;
}

export interface BootstrapEnumerationRunsPort {
    updateRunStatus(
        runId: number,
        status: typeof BOOTSTRAP_RUN_STATUS.Failed,
        error?: { code: string; message: string } | null,
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

export interface BootstrapEnumerationStepsPort {
    markStepRunning(
        runId: number,
        stepKey:
            | typeof BOOTSTRAP_STEP_KEY.Enumeration
            | typeof BOOTSTRAP_STEP_KEY.Metadata,
    ): void;
    markStepSucceeded(
        runId: number,
        stepKey: typeof BOOTSTRAP_STEP_KEY.Enumeration,
        progress: { completed: number; total: number | null },
    ): void;
    markStepFailedTerminal(input: {
        runId: number;
        stepKey: BootstrapStepKey;
        attempts: number;
        error: string;
    }): void;
    updateStepProgress(
        runId: number,
        stepKey:
            | typeof BOOTSTRAP_STEP_KEY.Enumeration
            | typeof BOOTSTRAP_STEP_KEY.Metadata,
        progress: { completed: number; total: number | null },
    ): void;
}

// Executes token enumeration and durable metadata task seeding for a bootstrap run.
export class BootstrapEnumerationExecutor {
    constructor(
        private readonly resolverPort: BootstrapEnumerationResolverPort,
        private readonly storagePort: BootstrapEnumerationStoragePort,
        private readonly runsPort: BootstrapEnumerationRunsPort,
        private readonly stepsPort: BootstrapEnumerationStepsPort,
        private readonly heartbeatMs: number,
    ) {}

    async execute(
        input: BootstrapEnumerationInput,
    ): Promise<BootstrapEnumerationExecutorResult> {
        const { run, anchor } = input;
        let activeStep: BootstrapStepKey = BOOTSTRAP_STEP_KEY.Enumeration;
        try {
            this.resetTemporaryWork(run.runId);
            this.stepsPort.markStepRunning(
                run.runId,
                BOOTSTRAP_STEP_KEY.Enumeration,
            );
            this.runsPort.appendRunEvent({
                runId: run.runId,
                chainId: run.chainId,
                collectionId: run.collectionId,
                eventCode: BOOTSTRAP_RUN_EVENT_CODE.MetadataEnumerationStarted,
                eventLevel: "info",
                message: "Token enumeration started",
                payloadJson: JSON.stringify({
                    enumerationMode: run.enumerationMode,
                    anchorBlock: anchor.anchorBlock,
                }),
            });

            const enumerationStartedAt = Date.now();
            const tokenIds = await this.enumerateTokenIds(
                run,
                anchor.anchorBlock,
                enumerationStartedAt,
            );
            const elapsedMs = Date.now() - enumerationStartedAt;
            this.completeEnumeration(run, tokenIds.length, elapsedMs);

            activeStep = BOOTSTRAP_STEP_KEY.Metadata;
            this.seedMetadataTasks(run, anchor, tokenIds, input.metadataBatchSize);
            this.runsPort.appendRunEvent({
                runId: run.runId,
                chainId: run.chainId,
                collectionId: run.collectionId,
                eventCode: BOOTSTRAP_RUN_EVENT_CODE.MetadataQueued,
                eventLevel: "info",
                message: "Bootstrap metadata phase queued",
                payloadJson: JSON.stringify({
                    anchorBlock: anchor.anchorBlock,
                    metadataMode: run.metadataMode,
                    tokenCount: tokenIds.length,
                }),
            });
            logger.info("Bootstrap metadata phase queued", {
                component: BOOTSTRAP_ENUMERATION_EXECUTOR_LOG.Component,
                action: BOOTSTRAP_ENUMERATION_EXECUTOR_LOG.Action,
                runId: run.runId,
                chainId: run.chainId,
                collectionId: run.collectionId,
                address: run.requestAddress,
                standard: run.requestStandard,
                anchorBlock: anchor.anchorBlock,
                metadataMode: run.metadataMode,
                tokenCount: tokenIds.length,
            });

            return {
                outcome:
                    BOOTSTRAP_ENUMERATION_EXECUTOR_OUTCOME.MetadataQueued,
                tokenCount: tokenIds.length,
                elapsedMs,
            };
        } catch (error) {
            const message = String(error);
            logger.error("Bootstrap enumeration failed", {
                component: BOOTSTRAP_ENUMERATION_EXECUTOR_LOG.Component,
                action: BOOTSTRAP_ENUMERATION_EXECUTOR_LOG.Action,
                runId: run.runId,
                chainId: run.chainId,
                collectionId: run.collectionId,
                address: run.requestAddress,
                standard: run.requestStandard,
                anchorBlock: anchor.anchorBlock,
                error: message,
            });
            this.stepsPort.markStepFailedTerminal({
                runId: run.runId,
                stepKey: activeStep,
                attempts: 1,
                error: message,
            });
            this.runsPort.updateRunStatus(run.runId, BOOTSTRAP_RUN_STATUS.Failed, {
                code: BOOTSTRAP_ENUMERATION_FAILURE_CODE.BootstrapStartFailed,
                message,
            });
            this.runsPort.appendRunEvent({
                runId: run.runId,
                chainId: run.chainId,
                collectionId: run.collectionId,
                eventCode: BOOTSTRAP_RUN_EVENT_CODE.RunFailed,
                eventLevel: "error",
                message: "Bootstrap start failed",
                payloadJson: JSON.stringify({ error: message }),
            });
            throw error;
        }
    }

    private resetTemporaryWork(runId: number): void {
        this.storagePort.resetSnapshot(runId);
        this.storagePort.resetMetadataTasks(runId);
        this.storagePort.resetImageCacheTasks(runId);
        this.storagePort.resetOwnershipTasks(runId);
    }

    private async enumerateTokenIds(
        run: BootstrapRunDefinition,
        anchorBlock: number,
        startedAt: number,
    ): Promise<string[]> {
        logger.info("Bootstrap token enumeration starting", {
            component: BOOTSTRAP_ENUMERATION_EXECUTOR_LOG.Component,
            action: BOOTSTRAP_ENUMERATION_EXECUTOR_LOG.Action,
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            enumerationMode: run.enumerationMode,
            anchorBlock,
        });

        let resolvedCount = 0;
        let totalCount: number | null = null;
        const heartbeat = setInterval(() => {
            logger.info("Bootstrap token enumeration in progress", {
                component: BOOTSTRAP_ENUMERATION_EXECUTOR_LOG.Component,
                action: BOOTSTRAP_ENUMERATION_EXECUTOR_LOG.Action,
                runId: run.runId,
                chainId: run.chainId,
                collectionId: run.collectionId,
                enumerationMode: run.enumerationMode,
                resolvedTokenIds: resolvedCount,
                totalTokenIds: totalCount,
                elapsedMs: Date.now() - startedAt,
            });
        }, Math.max(1, this.heartbeatMs));

        try {
            return await this.resolverPort.resolveTokenIds({
                run,
                anchorBlock,
                onProgress: (progress) => {
                    resolvedCount = progress.resolved;
                    totalCount = progress.total;
                    this.recordEnumerationProgress(run, progress, startedAt);
                },
            });
        } finally {
            clearInterval(heartbeat);
        }
    }

    private recordEnumerationProgress(
        run: BootstrapRunDefinition,
        progress: { resolved: number; total: number | null },
        startedAt: number,
    ): void {
        this.stepsPort.updateStepProgress(
            run.runId,
            BOOTSTRAP_STEP_KEY.Enumeration,
            {
                completed: progress.resolved,
                total: progress.total,
            },
        );
        if (
            progress.resolved !== progress.total &&
            progress.resolved % BOOTSTRAP_ENUMERATION_PROGRESS_EVENT_STEP !== 0
        ) {
            return;
        }

        logger.info("Bootstrap token enumeration progress", {
            component: BOOTSTRAP_ENUMERATION_EXECUTOR_LOG.Component,
            action: BOOTSTRAP_ENUMERATION_EXECUTOR_LOG.Action,
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            enumerationMode: run.enumerationMode,
            resolvedTokenIds: progress.resolved,
            totalTokenIds: progress.total,
            elapsedMs: Date.now() - startedAt,
        });
        if (
            progress.total !== null &&
            progress.resolved > 0 &&
            progress.resolved < progress.total
        ) {
            this.runsPort.appendRunEvent({
                runId: run.runId,
                chainId: run.chainId,
                collectionId: run.collectionId,
                eventCode: BOOTSTRAP_RUN_EVENT_CODE.MetadataEnumerationProgress,
                eventLevel: "info",
                message: "Token enumeration progress",
                payloadJson: serializeBootstrapEnumerationProgressEventPayload({
                    resolved: progress.resolved,
                    total: progress.total,
                }),
            });
        }
    }

    private completeEnumeration(
        run: BootstrapRunDefinition,
        tokenCount: number,
        elapsedMs: number,
    ): void {
        logger.info("Bootstrap token enumeration completed", {
            component: BOOTSTRAP_ENUMERATION_EXECUTOR_LOG.Component,
            action: BOOTSTRAP_ENUMERATION_EXECUTOR_LOG.Action,
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            enumerationMode: run.enumerationMode,
            tokenCount,
            elapsedMs,
        });
        this.runsPort.appendRunEvent({
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            eventCode: BOOTSTRAP_RUN_EVENT_CODE.MetadataEnumerationCompleted,
            eventLevel: "info",
            message: "Token enumeration completed",
            payloadJson: JSON.stringify({
                enumerationMode: run.enumerationMode,
                tokenCount,
                elapsedMs,
            }),
        });
        this.stepsPort.markStepSucceeded(
            run.runId,
            BOOTSTRAP_STEP_KEY.Enumeration,
            {
                completed: tokenCount,
                total: tokenCount,
            },
        );
    }

    private seedMetadataTasks(
        run: BootstrapRunDefinition,
        anchor: BootstrapEnumerationAnchor,
        tokenIds: string[],
        batchSize: number,
    ): void {
        const writeBatchSize = Math.max(1, batchSize);
        const normalizedContract = run.requestAddress.toLowerCase();
        logger.info("Bootstrap metadata task seeding started", {
            component: BOOTSTRAP_ENUMERATION_EXECUTOR_LOG.Component,
            action: BOOTSTRAP_ENUMERATION_EXECUTOR_LOG.Action,
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            tokenCount: tokenIds.length,
            writeBatchSize,
        });

        let seededCount = 0;
        // Split inserts so large collections avoid one huge SQLite transaction.
        for (
            let cursor = 0;
            cursor < tokenIds.length;
            cursor += writeBatchSize
        ) {
            const end = Math.min(tokenIds.length, cursor + writeBatchSize);
            const rows: BootstrapMetadataTaskSeed[] = [];
            for (let index = cursor; index < end; index += 1) {
                rows.push({
                    runId: run.runId,
                    chainId: run.chainId,
                    collectionId: run.collectionId,
                    contract: normalizedContract,
                    tokenId: tokenIds[index]!,
                    standard: COLLECTION_STANDARD.Erc721,
                    anchorBlock: anchor.anchorBlock,
                    anchorHash: anchor.anchorHash,
                    anchorTimestamp: anchor.anchorTimestamp,
                });
            }
            this.storagePort.insertMetadataTasks(rows);
            seededCount += rows.length;
            this.stepsPort.updateStepProgress(
                run.runId,
                BOOTSTRAP_STEP_KEY.Metadata,
                {
                    completed: 0,
                    total: tokenIds.length,
                },
            );
            if (
                seededCount === tokenIds.length ||
                seededCount % BOOTSTRAP_METADATA_TASK_SEED_LOG_STEP === 0
            ) {
                logger.info("Bootstrap metadata task seeding progress", {
                    component: BOOTSTRAP_ENUMERATION_EXECUTOR_LOG.Component,
                    action: BOOTSTRAP_ENUMERATION_EXECUTOR_LOG.Action,
                    runId: run.runId,
                    chainId: run.chainId,
                    collectionId: run.collectionId,
                    seededCount,
                    tokenCount: tokenIds.length,
                });
            }
        }
        this.runsPort.appendRunEvent({
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            eventCode: BOOTSTRAP_RUN_EVENT_CODE.MetadataTasksSeeded,
            eventLevel: "info",
            message: "Metadata tasks seeded",
            payloadJson: JSON.stringify({
                tokenCount: tokenIds.length,
                writeBatchSize,
            }),
        });
    }
}
