import { Mutex } from "async-mutex";
import {
    TRADING_JOB_COMMAND_KIND,
    TRADING_JOB_STATUS,
} from "@artgod/shared/types";
import { biddingLog } from "../../../utils/bidding-log.js";
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
}

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
                biddingLog.debug(
                    `[BiddingJobCommandReconciler] No pending commands. trigger=${trigger}`,
                );
                return 0;
            }

            biddingLog.info(
                `[BiddingJobCommandReconciler] Processing ${commands.length} command(s). trigger=${trigger}`,
            );
            for (const command of commands) {
                await this.processCommand(command);
            }
            return commands.length;
        });
    }

    private async processCommand(command: BiddingJobCommand): Promise<void> {
        try {
            await this.applyCommand(command);
            await this.commandRepository.markCompleted(command.commandId);
            biddingLog.info(
                `[BiddingJobCommandReconciler] Completed command. commandId=${command.commandId}, kind=${command.commandKind}, jobId=${command.jobId}, attempts=${command.attempts}`,
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (command.attempts >= this.options.maxAttempts) {
                await this.commandRepository.markFailedTerminal(
                    command.commandId,
                    message,
                );
                biddingLog.error(
                    `[BiddingJobCommandReconciler] Command failed terminally. commandId=${command.commandId}, kind=${command.commandKind}, jobId=${command.jobId}, attempts=${command.attempts}, error=${message}`,
                );
                return;
            }

            await this.commandRepository.markFailedRetry(
                command.commandId,
                message,
            );
            biddingLog.warn(
                `[BiddingJobCommandReconciler] Command failed and will retry. commandId=${command.commandId}, kind=${command.commandKind}, jobId=${command.jobId}, attempts=${command.attempts}, error=${message}`,
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
            biddingLog.warn(
                `[BiddingJobCommandReconciler] Job command references missing job. commandId=${command.commandId}, kind=${command.commandKind}, jobId=${command.jobId}`,
            );
            return;
        }

        if (record.status !== TRADING_JOB_STATUS.Enabled) {
            this.bidder.removeJob(command.jobId);
            biddingLog.info(
                `[BiddingJobCommandReconciler] Removed non-enabled job from scheduling. commandId=${command.commandId}, kind=${command.commandKind}, jobId=${command.jobId}, status=${record.status}`,
            );
            return;
        }

        await this.jobPreparationPort.prepareEnabledJob(record.job);
        this.bidder.addJob(record.job);
        biddingLog.info(
            `[BiddingJobCommandReconciler] Applied enabled job. commandId=${command.commandId}, kind=${command.commandKind}, jobId=${command.jobId}, revision=${record.revision}`,
        );
        // Run an immediate refresh so DB-driven changes affect market state without waiting for the next tick.
        await this.bidder.refreshJob(record.job.id);
    }

    private removeJobFromScheduling(command: BiddingJobCommand): void {
        const removed = this.bidder.removeJob(command.jobId);
        biddingLog.info(
            `[BiddingJobCommandReconciler] Removed job from scheduling. commandId=${command.commandId}, kind=${command.commandKind}, jobId=${command.jobId}, removed=${removed ? "yes" : "no"}`,
        );
    }

    private async cancelActiveOffer(command: BiddingJobCommand): Promise<void> {
        const job = await this.resolveJobForCancellation(command);
        if (!job) {
            biddingLog.warn(
                `[BiddingJobCommandReconciler] Cannot cancel active offer for missing job. commandId=${command.commandId}, jobId=${command.jobId}`,
            );
            return;
        }

        const cancelled = await this.bidder.cancelActiveOffersForJob(job);
        biddingLog.info(
            `[BiddingJobCommandReconciler] Active-offer cancellation processed. commandId=${command.commandId}, jobId=${command.jobId}, cancelled=${cancelled}`,
        );
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
}
