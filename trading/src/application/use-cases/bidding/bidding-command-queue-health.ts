import { TRADING_JOB_COMMAND_STATUS } from "@artgod/shared/types";

// Completed history is intentionally excluded from periodic backlog reads.
export const BIDDING_COMMAND_QUEUE_STATUS = {
    Pending: TRADING_JOB_COMMAND_STATUS.Pending,
    Retrying: TRADING_JOB_COMMAND_STATUS.FailedRetry,
    Processing: TRADING_JOB_COMMAND_STATUS.Processing,
    FailedTerminal: TRADING_JOB_COMMAND_STATUS.FailedTerminal,
} as const;
export type BiddingCommandQueueStatus =
    (typeof BIDDING_COMMAND_QUEUE_STATUS)[keyof typeof BIDDING_COMMAND_QUEUE_STATUS];

export type BiddingCommandQueueHealth = {
    counts: Record<BiddingCommandQueueStatus, number>;
    oldestPendingAtMs: number | null;
    staleProcessing: number;
};

// The adapter reads the same durable scope and stale-claim policy used by admission.
export interface BiddingCommandQueueHealthPort {
    readQueueHealth(claimTimeoutMs: number): Promise<BiddingCommandQueueHealth>;
}
