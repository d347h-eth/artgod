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
            // Claim a bounded batch from the DB Outbox before touching live bidder state.
            const commands = await this.commandRepository.claimNextBatch({
                limit: this.options.batchSize,
                claimTimeoutMs: this.options.claimTimeoutMs,
            });
            if (commands.length === 0) {
                return 0;
            }

            log.info("processCommands", "Processing bidding job commands", {
                trigger,
                commandCount: commands.length,
            });
            for (const command of commands) {
                await this.processCommand(command);
            }
            return commands.length;
        });
    }

    private async processCommand(command: BiddingJobCommand): Promise<void> {
        try {
            await this.applyCommand(command);
            await this.reconcileEnabledJobs();
            await this.commandRepository.markCompleted(command.commandId);
            log.info("commandCompleted", "Completed bidding job command", {
                ...commandLogFields(command),
            });
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
                return;
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
        await this.bidder.refreshJob(record.job.id);
    }

    private removeJobFromScheduling(command: BiddingJobCommand): void {
        const removed = this.bidder.removeJob(command.jobId);
        log.info("jobRemoved", "Removed bidding job from scheduling", {
            ...commandLogFields(command),
            removed,
        });
    }

    private async cancelActiveOffer(command: BiddingJobCommand): Promise<void> {
        const job = await this.resolveJobForCancellation(command);
        if (!job) {
            log.warn(
                "cancelMissingJob",
                "Cannot cancel active offer for missing bidding job",
                commandLogFields(command),
            );
            return;
        }

        const cancelled = await this.bidder.cancelActiveOffersForJob(job);
        log.info("activeOfferCancellationProcessed", "Active-offer cancellation processed", {
            ...commandLogFields(command),
            cancelled,
        });
    }

    private async resolveJobForCancellation(
        command: BiddingJobCommand,
    ): Promise<BidderJob | null> {
        const inMemoryJob = this.bidder.getJob(command.jobId);
        if (inMemoryJob) {
            return inMemoryJob;
        }

        // Load archived or paused declarations too so restart recovery can still discover maker offers by target.
        const record = await this.jobSource.loadJobById(command.jobId);
        return record?.job ?? null;
    }

    private async reconcileEnabledJobs(): Promise<void> {
        // Reload enabled declarations so runtime watch state follows DB truth after each command.
        const jobs = await this.jobSource.loadEnabledJobs();
        await this.jobPreparationPort.reconcileEnabledJobs(jobs);
    }
}

function commandLogFields(command: BiddingJobCommand): Record<string, unknown> {
    return {
        commandId: command.commandId,
        commandKind: command.commandKind,
        jobId: command.jobId,
        attempts: command.attempts,
    };
}
