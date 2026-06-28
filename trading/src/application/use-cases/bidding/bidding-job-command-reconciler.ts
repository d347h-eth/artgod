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

export type BiddingJobCommandReconcilerOptions = {
    batchSize: number;
    claimTimeoutMs: number;
    maxAttempts: number;
};

export interface BiddingRuntimeJobPreparationPort {
    prepareEnabledJob(job: BidderJob): Promise<void>;
    reconcileEnabledJobs(jobs: BidderJob[]): Promise<void>;
}

const log = createBiddingComponentLogger(
    BIDDING_LOG_COMPONENT.BiddingCommandReconciler,
);

// Ordered command replay claims one row at a time so later commands do not hide behind an earlier retry.
const ORDERED_COMMAND_CLAIM_LIMIT = 1;

// BiddingJobCommandReconciler applies durable DB Outbox commands to the live bidder.
export class BiddingJobCommandReconciler {
    private readonly mutex = new Mutex();

    constructor(
        private readonly commandRepository: BiddingJobCommandRepository,
        private readonly jobSource: BiddingJobSource,
        private readonly bidder: Bidder,
        private readonly jobPreparationPort: BiddingRuntimeJobPreparationPort,
        private readonly options: BiddingJobCommandReconcilerOptions,
    ) {}

    async processPendingCommands(trigger: string): Promise<number> {
        return await this.mutex.runExclusive(async () => {
            let processed = 0;
            while (processed < this.options.batchSize) {
                // Claim the next command only after all earlier commands have completed.
                const commands = await this.commandRepository.claimNextBatch({
                    limit: ORDERED_COMMAND_CLAIM_LIMIT,
                    claimTimeoutMs: this.options.claimTimeoutMs,
                });
                const command = commands[0];
                if (!command) {
                    return processed;
                }

                log.info("processCommands", "Processing bidding job commands", {
                    trigger,
                    commandCount: commands.length,
                });
                processed += 1;
                const commandSucceeded = await this.processCommand(command);
                if (!commandSucceeded) {
                    break;
                }
            }
            return processed;
        });
    }

    private async processCommand(command: BiddingJobCommand): Promise<boolean> {
        try {
            await this.applyCommand(command);
            await this.reconcileEnabledJobs();
            await this.commandRepository.markCompleted(command.commandId);
            log.info("commandCompleted", "Completed bidding job command", {
                ...commandLogFields(command),
            });
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (command.attempts >= this.options.maxAttempts) {
                await this.commandRepository.markFailedTerminal(
                    command.commandId,
                    message,
                );
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
            log.warn(
                "commandRetryFailure",
                "Bidding job command failed and will retry",
                {
                    ...commandLogFields(command),
                    ...toErrorLogFields(error),
                },
            );
            return false;
        }
    }

    private async applyCommand(command: BiddingJobCommand): Promise<void> {
        if (
            command.commandKind === TRADING_JOB_COMMAND_KIND.JobCreated ||
            command.commandKind === TRADING_JOB_COMMAND_KIND.JobUpdated
        ) {
            await this.applyDesiredJob(command);
            return;
        }

        if (
            command.commandKind === TRADING_JOB_COMMAND_KIND.JobPaused ||
            command.commandKind === TRADING_JOB_COMMAND_KIND.JobArchived
        ) {
            this.removeJobFromScheduling(command);
            return;
        }

        if (command.commandKind === TRADING_JOB_COMMAND_KIND.CancelActiveOffer) {
            await this.cancelActiveOffer(command);
            return;
        }

        throw new Error(
            `Unsupported bidding job command kind: ${String(command.commandKind)}`,
        );
    }

    private async applyDesiredJob(command: BiddingJobCommand): Promise<void> {
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

        await this.jobPreparationPort.prepareEnabledJob(record.job);
        this.bidder.addJob(record.job);
        log.info("enabledJobApplied", "Applied enabled bidding job", {
            ...commandLogFields(command),
            revision: record.revision,
        });
        // Run an immediate refresh so DB-driven changes affect market state without waiting for the next tick.
        await this.bidder.refreshJobForCommand(record.job.id);
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
            cancelled = await this.bidder.cancelActiveOffersForJob(job);
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
    return typeof value === "string" && value.trim() !== ""
        ? value
        : undefined;
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
