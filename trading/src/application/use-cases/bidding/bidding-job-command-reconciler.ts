import { Mutex } from "async-mutex";
import {
    TRADING_JOB_COMMAND_KIND,
    TRADING_JOB_STATUS,
} from "@artgod/shared/types";
import {
    BIDDING_LOG_COMPONENT,
    createBiddingComponentLogger,
    toErrorLogFields,
} from "../../../utils/bidding-log.js";
import type { BidderJob } from "../../../domain/market/strategy/job.js";
import { Bidder } from "./bidder.js";
import type {
    BiddingJobCommand,
    BiddingJobCommandRepository,
} from "./bidding-job-command-repository.js";
import type { BiddingJobSource } from "./bidding-job-source.js";
import { observeBestEffort } from "../../../utils/observe-best-effort.js";
import {
    BIDDING_WORK_STAGE,
    observeBiddingWork,
    type BiddingWorkObservabilityPort,
} from "./bidding-work-observability.js";

export type BiddingJobCommandReconcilerOptions = {
    batchSize: number;
    claimTimeoutMs: number;
    maxAttempts: number;
};

// Stable reconciliation origins keep command-latency metrics low-cardinality.
export const BIDDING_COMMAND_TRIGGER = {
    Startup: "startup",
    Poll: "poll",
    Signal: "signal",
} as const;

export type BiddingCommandTrigger =
    (typeof BIDDING_COMMAND_TRIGGER)[keyof typeof BIDDING_COMMAND_TRIGGER];

// Reconciliation results distinguish a drained batch from a batch stopped by a command failure.
export const BIDDING_COMMAND_RECONCILIATION_RESULT = {
    Success: "success",
    CompletedWithFailures: "completed_with_failures",
    Failure: "failure",
    Stopped: "stopped",
} as const;

export type BiddingCommandReconciliationResult =
    (typeof BIDDING_COMMAND_RECONCILIATION_RESULT)[keyof typeof BIDDING_COMMAND_RECONCILIATION_RESULT];

// These are persisted lifecycle transitions, not the result of a processing attempt.
export const BIDDING_COMMAND_DURABLE_OUTCOME = {
    Completed: "completed",
    RetryScheduled: "retry_scheduled",
    FailedTerminal: "failed_terminal",
    StaleClaimRecovered: "stale_claim_recovered",
} as const;
export type BiddingCommandDurableOutcome =
    (typeof BIDDING_COMMAND_DURABLE_OUTCOME)[keyof typeof BIDDING_COMMAND_DURABLE_OUTCOME];

// BiddingCommandObservabilityPort reports durable queue and strategy latency without command identity.
export interface BiddingCommandObservabilityPort extends BiddingWorkObservabilityPort {
    onCommandDurableOutcome?(input: {
        commandKind: BiddingJobCommand["commandKind"];
        outcome: BiddingCommandDurableOutcome;
    }): void;
    onReconciliationFinished(input: {
        trigger: BiddingCommandTrigger;
        processed: number;
        durationMs: number;
        result: BiddingCommandReconciliationResult;
    }): void;
    onCommandClaimed(input: {
        trigger: BiddingCommandTrigger;
        commandKind: BiddingJobCommand["commandKind"];
        queueWaitMs: number;
    }): void;
    onCommandStrategyStarted(input: {
        trigger: BiddingCommandTrigger;
        commandKind: BiddingJobCommand["commandKind"];
        claimToStrategyMs: number;
        createdToStrategyMs: number;
    }): void;
    // A retried durable command produces one observation for each processing attempt.
    onCommandFinished(input: {
        trigger: BiddingCommandTrigger;
        commandKind: BiddingJobCommand["commandKind"];
        durationMs: number;
        succeeded: boolean;
    }): void;
    onCommandInFlightChanged(count: number): void;
}

// BiddingJobCommandProgress is the observable unit of command replay progress.
export type BiddingJobCommandProgress = {
    trigger: BiddingCommandTrigger;
    commandId: number;
    commandKind: BiddingJobCommand["commandKind"];
    jobId: string;
    processed: number;
    batchSize: number;
};

// BiddingJobCommandReconciliationObserver lets runtimes publish progress without changing command semantics.
export type BiddingJobCommandReconciliationObserver = {
    onCommandStarted?: (progress: BiddingJobCommandProgress) => void;
    onCommandFinished?: (
        progress: BiddingJobCommandProgress & { succeeded: boolean },
    ) => void;
};

export interface BiddingRuntimeJobPreparationPort {
    prepareEnabledJob(job: BidderJob): Promise<void>;
    reconcileEnabledJobs(jobs: BidderJob[]): Promise<void>;
}

export type BiddingOfferCancellationFailure = {
    jobId: string;
    orderId: string;
    cancellationError: string;
};

export interface BiddingOfferCancellationLifecyclePort {
    markOfferCancellationFailed(
        failure: BiddingOfferCancellationFailure,
    ): Promise<void> | void;
}

const log = createBiddingComponentLogger(
    BIDDING_LOG_COMPONENT.BiddingCommandReconciler,
);

const BIDDING_COMMAND_RECONCILER_LOG_ACTION = {
    EnabledJobAlreadySatisfied: "enabledJobAlreadySatisfied",
    CommandStarted: "commandStarted",
    CommandProgress: "commandProgress",
    CancellationTerminalFailureRecordFailed:
        "cancellationTerminalFailureRecordFailed",
} as const;

// Ordered command replay claims one row at a time so later commands do not hide behind an earlier retry.
const ORDERED_COMMAND_CLAIM_LIMIT = 1;

// BiddingJobCommandReconciler applies durable DB Outbox commands to the live bidder.
export class BiddingJobCommandReconciler {
    private readonly mutex = new Mutex();
    private acceptingCommands = true;

    constructor(
        private readonly commandRepository: BiddingJobCommandRepository,
        private readonly jobSource: BiddingJobSource,
        private readonly bidder: Bidder,
        private readonly jobPreparationPort: BiddingRuntimeJobPreparationPort,
        private readonly options: BiddingJobCommandReconcilerOptions,
        private readonly cancellationLifecyclePort?: BiddingOfferCancellationLifecyclePort,
        private readonly observability?: BiddingCommandObservabilityPort,
    ) {
        observeBestEffort(() => {
            this.observability?.onCommandInFlightChanged(0);
        });
    }

    // Closing admission preserves an already-started atomic claim, but never starts another.
    closeAdmission(): void {
        this.acceptingCommands = false;
    }

    async processPendingCommands(
        trigger: BiddingCommandTrigger,
        observer: BiddingJobCommandReconciliationObserver = {},
    ): Promise<number> {
        const startedAt = Date.now();
        let processed = 0;
        let result: BiddingCommandReconciliationResult =
            BIDDING_COMMAND_RECONCILIATION_RESULT.Failure;
        try {
            const batch = await this.mutex.runExclusive(async () => {
                // Check after mutex acquisition and between claims: queued signal handlers
                // must not turn scheduler shutdown into admission of another batch.
                while (
                    this.acceptingCommands &&
                    processed < this.options.batchSize
                ) {
                    // Claim the next command only after all earlier commands have completed.
                    const commands =
                        await this.commandRepository.claimNextBatch({
                            limit: ORDERED_COMMAND_CLAIM_LIMIT,
                            claimTimeoutMs: this.options.claimTimeoutMs,
                        });
                    const command = commands[0];
                    if (!command) {
                        return { processed, completedWithFailures: false };
                    }
                    if (command.reclaimed)
                        this.reportDurableOutcome(
                            command,
                            BIDDING_COMMAND_DURABLE_OUTCOME.StaleClaimRecovered,
                        );

                    log.info(
                        "processCommands",
                        "Processing bidding job commands",
                        {
                            trigger,
                            commandCount: commands.length,
                        },
                    );
                    processed += 1;
                    const progress = this.createCommandProgress(
                        trigger,
                        command,
                        processed,
                    );
                    log.info(
                        BIDDING_COMMAND_RECONCILER_LOG_ACTION.CommandStarted,
                        "Started bidding job command",
                        progress,
                    );
                    observeBestEffort(() => {
                        observer.onCommandStarted?.(progress);
                    });
                    observeBestEffort(() => {
                        this.observability?.onCommandClaimed({
                            trigger,
                            commandKind: command.commandKind,
                            queueWaitMs: Math.max(
                                0,
                                command.claimedAtMs - command.createdAtMs,
                            ),
                        });
                    });
                    const commandSucceeded = await observeBiddingWork(
                        this.observability,
                        BIDDING_WORK_STAGE.Command,
                        () => this.processCommand(command, trigger),
                        (succeeded) => succeeded,
                    );
                    log.info(
                        BIDDING_COMMAND_RECONCILER_LOG_ACTION.CommandProgress,
                        "Bidding job command progress",
                        {
                            ...progress,
                            succeeded: commandSucceeded,
                        },
                    );
                    observeBestEffort(() => {
                        observer.onCommandFinished?.({
                            ...progress,
                            succeeded: commandSucceeded,
                        });
                    });
                    if (!commandSucceeded) {
                        return { processed, completedWithFailures: true };
                    }
                }
                return { processed, completedWithFailures: false };
            });
            processed = batch.processed;
            result = batch.completedWithFailures
                ? BIDDING_COMMAND_RECONCILIATION_RESULT.CompletedWithFailures
                : this.acceptingCommands
                  ? BIDDING_COMMAND_RECONCILIATION_RESULT.Success
                  : BIDDING_COMMAND_RECONCILIATION_RESULT.Stopped;
            return processed;
        } finally {
            observeBestEffort(() => {
                this.observability?.onReconciliationFinished({
                    trigger,
                    processed,
                    durationMs: Date.now() - startedAt,
                    result,
                });
            });
        }
    }

    private createCommandProgress(
        trigger: BiddingCommandTrigger,
        command: BiddingJobCommand,
        processed: number,
    ): BiddingJobCommandProgress {
        return {
            trigger,
            commandId: command.commandId,
            commandKind: command.commandKind,
            jobId: command.jobId,
            processed,
            batchSize: this.options.batchSize,
        };
    }

    private async processCommand(
        command: BiddingJobCommand,
        trigger: BiddingCommandTrigger,
    ): Promise<boolean> {
        const startedAt = Date.now();
        let succeeded = false;
        observeBestEffort(() => {
            this.observability?.onCommandInFlightChanged(1);
        });
        try {
            await this.applyCommand(command, (strategyStartedAtMs) => {
                observeBestEffort(() => {
                    this.observability?.onCommandStrategyStarted({
                        trigger,
                        commandKind: command.commandKind,
                        claimToStrategyMs: Math.max(
                            0,
                            strategyStartedAtMs - command.claimedAtMs,
                        ),
                        createdToStrategyMs: Math.max(
                            0,
                            strategyStartedAtMs - command.createdAtMs,
                        ),
                    });
                });
            });
            await this.reconcileEnabledJobs();
            await this.commandRepository.markCompleted(command.commandId);
            this.reportDurableOutcome(
                command,
                BIDDING_COMMAND_DURABLE_OUTCOME.Completed,
            );
            log.info("commandCompleted", "Completed bidding job command", {
                ...commandLogFields(command),
            });
            succeeded = true;
            return true;
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            if (command.attempts >= this.options.maxAttempts) {
                await this.commandRepository.markFailedTerminal(
                    command.commandId,
                    message,
                );
                this.reportDurableOutcome(
                    command,
                    BIDDING_COMMAND_DURABLE_OUTCOME.FailedTerminal,
                );
                await this.markTerminalCancellationFailure(command, message);
                log.error(
                    "commandTerminalFailure",
                    "Bidding job command failed terminally",
                    {
                        ...commandLogFields(command),
                        ...toErrorLogFields(error),
                    },
                );
                return false;
            }

            await this.commandRepository.markFailedRetry(
                command.commandId,
                message,
            );
            this.reportDurableOutcome(
                command,
                BIDDING_COMMAND_DURABLE_OUTCOME.RetryScheduled,
            );
            log.warn(
                "commandRetryFailure",
                "Bidding job command failed and will retry",
                {
                    ...commandLogFields(command),
                    ...toErrorLogFields(error),
                },
            );
            return false;
        } finally {
            observeBestEffort(() => {
                this.observability?.onCommandFinished({
                    trigger,
                    commandKind: command.commandKind,
                    durationMs: Date.now() - startedAt,
                    succeeded,
                });
            });
            observeBestEffort(() => {
                this.observability?.onCommandInFlightChanged(0);
            });
        }
    }

    private reportDurableOutcome(
        command: BiddingJobCommand,
        outcome: BiddingCommandDurableOutcome,
    ): void {
        observeBestEffort(() =>
            this.observability?.onCommandDurableOutcome?.({
                commandKind: command.commandKind,
                outcome,
            }),
        );
    }

    private async markTerminalCancellationFailure(
        command: BiddingJobCommand,
        message: string,
    ): Promise<void> {
        if (
            command.commandKind !==
                TRADING_JOB_COMMAND_KIND.CancelActiveOffer ||
            !this.cancellationLifecyclePort
        ) {
            return;
        }

        const orderId = parseOptionalPayloadString(
            command.payload.activeOrderId,
        );
        if (!orderId) {
            return;
        }

        try {
            // Settle the cancellation lifecycle row so the bid book never shows an endless canceling state.
            await this.cancellationLifecyclePort.markOfferCancellationFailed({
                jobId: command.jobId,
                orderId,
                cancellationError: message,
            });
        } catch (error) {
            log.error(
                BIDDING_COMMAND_RECONCILER_LOG_ACTION.CancellationTerminalFailureRecordFailed,
                "Failed to record terminal cancellation failure",
                {
                    ...commandLogFields(command),
                    orderId,
                    ...toErrorLogFields(error),
                },
            );
        }
    }

    private async applyCommand(
        command: BiddingJobCommand,
        onStrategyStarted: (startedAtMs: number) => void,
    ): Promise<void> {
        if (
            command.commandKind === TRADING_JOB_COMMAND_KIND.JobCreated ||
            command.commandKind === TRADING_JOB_COMMAND_KIND.JobUpdated
        ) {
            await this.applyDesiredJob(command, onStrategyStarted);
            return;
        }

        if (
            command.commandKind === TRADING_JOB_COMMAND_KIND.JobPaused ||
            command.commandKind === TRADING_JOB_COMMAND_KIND.JobArchived
        ) {
            this.removeJobFromScheduling(command);
            return;
        }

        if (
            command.commandKind === TRADING_JOB_COMMAND_KIND.CancelActiveOffer
        ) {
            await this.cancelActiveOffer(command);
            return;
        }

        throw new Error(
            `Unsupported bidding job command kind: ${String(command.commandKind)}`,
        );
    }

    private async applyDesiredJob(
        command: BiddingJobCommand,
        onStrategyStarted: (startedAtMs: number) => void,
    ): Promise<void> {
        // Reload the authoritative job declaration from SQLite before mutating live bidder state.
        const record = await this.jobSource.loadJobById(command.jobId);
        if (!record) {
            this.bidder.removeJob(command.jobId);
            log.warn(
                "commandMissingJob",
                "Bidding job command references a missing job",
                commandLogFields(command),
            );
            return;
        }

        if (record.status !== TRADING_JOB_STATUS.Enabled) {
            this.bidder.removeJob(command.jobId);
            log.info(
                "nonEnabledJobRemoved",
                "Removed non-enabled bidding job from scheduling",
                {
                    ...commandLogFields(command),
                    status: record.status,
                },
            );
            return;
        }

        if (this.completeAlreadySatisfiedJobCommand(command, record.job)) {
            return;
        }

        await observeBiddingWork(
            this.observability,
            BIDDING_WORK_STAGE.JobPreparation,
            () => this.jobPreparationPort.prepareEnabledJob(record.job),
        );
        this.bidder.addJob(record.job);
        if (this.completeAlreadySatisfiedJobCommand(command, record.job)) {
            return;
        }

        log.info("enabledJobApplied", "Applied enabled bidding job", {
            ...commandLogFields(command),
            revision: record.revision,
        });
        // Run an immediate refresh so DB-driven changes affect market state without waiting for the next tick.
        await this.bidder.refreshJobForCommand(
            record.job.id,
            onStrategyStarted,
        );
    }

    private completeAlreadySatisfiedJobCommand(
        command: BiddingJobCommand,
        job: BidderJob,
    ): boolean {
        const runtimeSnapshot = this.bidder.getSatisfiedRuntimeSnapshot(job);
        if (!runtimeSnapshot) {
            return false;
        }

        log.info(
            BIDDING_COMMAND_RECONCILER_LOG_ACTION.EnabledJobAlreadySatisfied,
            "Skipped enabled bidding job refresh because runtime state already satisfies the declaration",
            {
                ...commandLogFields(command),
                revision: job.revision,
                activeOrderId: runtimeSnapshot.activeOrderId,
                currentPriceWei: runtimeSnapshot.currentPrice.toString(),
                activeOrderVerifiedAt: runtimeSnapshot.activeOrderVerifiedAt,
            },
        );
        return true;
    }

    private removeJobFromScheduling(command: BiddingJobCommand): void {
        const removed = this.bidder.removeJob(command.jobId);
        log.info("jobRemoved", "Removed bidding job from scheduling", {
            ...commandLogFields(command),
            removed: Boolean(removed),
        });
    }

    private async cancelActiveOffer(command: BiddingJobCommand): Promise<void> {
        const inMemoryJob = this.bidder.getJob(command.jobId);
        // Read the durable declaration before deciding whether the live schedule should stop.
        const record = await this.jobSource.loadJobById(command.jobId);
        const removed =
            record?.status === TRADING_JOB_STATUS.Enabled
                ? undefined
                : this.bidder.removeJob(command.jobId);
        if (removed || record?.status !== TRADING_JOB_STATUS.Enabled) {
            log.info("jobRemoved", "Removed bidding job from scheduling", {
                ...commandLogFields(command),
                removed: Boolean(removed),
            });
        }

        const job = removed ?? inMemoryJob ?? record?.job ?? null;
        if (!job) {
            log.warn(
                "cancelMissingJob",
                "Cannot cancel active offer for missing bidding job",
                commandLogFields(command),
            );
            return;
        }

        this.applyCancellationPayload(job, command.payload);
        if (!hasTrackedActiveOrder(job)) {
            log.info(
                "activeOfferCancellationSkipped",
                "Skipped active-offer cancellation because no tracked active order exists",
                commandLogFields(command),
            );
            return;
        }

        const originalRevision = job.revision;
        const activeOrderJobRevision = parseOptionalPayloadNumber(
            command.payload.activeOrderJobRevision,
        );
        if (activeOrderJobRevision !== undefined) {
            job.revision = activeOrderJobRevision;
        }
        let cancelled = 0;
        try {
            cancelled = await this.bidder.cancelActiveOffersForCommand(job);
        } finally {
            job.revision = originalRevision;
        }
        log.info(
            "activeOfferCancellationProcessed",
            "Active-offer cancellation processed",
            {
                ...commandLogFields(command),
                cancelled,
            },
        );
    }

    private applyCancellationPayload(
        job: BidderJob,
        payload: Record<string, unknown>,
    ): void {
        if (!job.state.activeOrderId) {
            const activeOrderId = parseOptionalPayloadString(
                payload.activeOrderId,
            );
            if (activeOrderId) {
                job.state.activeOrderId = activeOrderId;
            }
        }

        if (!job.state.activeProtocolAddress) {
            const activeProtocolAddress = parseOptionalPayloadString(
                payload.activeProtocolAddress,
            );
            if (activeProtocolAddress) {
                job.state.activeProtocolAddress = activeProtocolAddress;
            }
        }

        if (!job.state.activeOrderPlacedAt) {
            const activeOrderPlacedAt = parseOptionalPayloadString(
                payload.activeOrderPlacedAt,
            );
            if (activeOrderPlacedAt) {
                job.state.activeOrderPlacedAt = activeOrderPlacedAt;
            }
        }

        if (job.state.currentPrice === undefined) {
            const currentPrice = parseOptionalPayloadBigInt(
                payload.currentPriceWei,
            );
            if (currentPrice !== undefined) {
                job.state.currentPrice = currentPrice;
            }
        }

        if (job.state.activeExpirationTimeMs === undefined) {
            const activeExpirationTimeMs = parseOptionalPayloadNumber(
                payload.activeExpirationTimeMs,
            );
            if (activeExpirationTimeMs !== undefined) {
                job.state.activeExpirationTimeMs = activeExpirationTimeMs;
            }
        }
    }

    private async reconcileEnabledJobs(): Promise<void> {
        // Reload enabled declarations so runtime watch state follows DB truth after each command.
        const jobs = await this.jobSource.loadEnabledJobs();
        await this.jobPreparationPort.reconcileEnabledJobs(jobs);
    }
}

function parseOptionalPayloadString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function parseOptionalPayloadBigInt(value: unknown): bigint | undefined {
    if (typeof value !== "string" || value.trim() === "") {
        return undefined;
    }

    try {
        return BigInt(value);
    } catch {
        return undefined;
    }
}

function parseOptionalPayloadNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value)
        ? value
        : undefined;
}

function hasTrackedActiveOrder(job: BidderJob): boolean {
    return (
        typeof job.state.activeOrderId === "string" &&
        job.state.activeOrderId.trim() !== ""
    );
}

function commandLogFields(command: BiddingJobCommand): Record<string, unknown> {
    return {
        commandId: command.commandId,
        commandKind: command.commandKind,
        jobId: command.jobId,
        attempts: command.attempts,
    };
}
