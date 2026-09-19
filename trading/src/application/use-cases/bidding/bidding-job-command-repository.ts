import type {
    TradingJobCommandKind,
    TradingJobCommandStatus,
} from "@artgod/shared/types";

export type BiddingJobCommand = {
    commandId: number;
    jobId: string;
    commandKind: TradingJobCommandKind;
    status: TradingJobCommandStatus;
    requestedRevision: number;
    payload: Record<string, unknown>;
    attempts: number;
    // createdAtMs is the durable enqueue time in Unix milliseconds.
    createdAtMs: number;
    // claimedAtMs is the current claim-attempt time in Unix milliseconds.
    claimedAtMs: number;
    // True only when this claim recovered an expired processing row, not an ordinary retry.
    reclaimed?: boolean;
};

// BiddingJobCommandRepository owns the durable Outbox command lifecycle for the running bot.
export interface BiddingJobCommandRepository {
    claimNextBatch(params: {
        limit: number;
        claimTimeoutMs: number;
    }): Promise<BiddingJobCommand[]>;
    markCompleted(commandId: number): Promise<void>;
    markFailedRetry(commandId: number, error: string): Promise<void>;
    markFailedTerminal(commandId: number, error: string): Promise<void>;
}
