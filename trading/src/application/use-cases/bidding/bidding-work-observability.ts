import { observeBestEffort } from "../../../utils/observe-best-effort.js";

// Bounded stages identify awaited business work, never the job or collection being processed.
export const BIDDING_WORK_STAGE = {
    AllowanceApproval: "allowance_approval",
    SnapshotBootstrap: "snapshot_bootstrap",
    PriceBootstrap: "price_bootstrap",
    CommandReconciliation: "command_reconciliation",
    BalanceRead: "balance_read",
    MarketRead: "market_read",
    OrderRecovery: "order_recovery",
    PlaceOffer: "place_offer",
    CancelOffer: "cancel_offer",
    Command: "command",
    JobPreparation: "job_preparation",
    SnapshotFetch: "snapshot_fetch",
    BidBookPublication: "bid_book_publication",
} as const;

export type BiddingWorkStage =
    (typeof BIDDING_WORK_STAGE)[keyof typeof BIDDING_WORK_STAGE];

export interface BiddingWorkObservabilityPort {
    // The returned completion belongs to this operation, even when concurrent starts share a timestamp.
    onWorkStarted?(stage: BiddingWorkStage): (succeeded: boolean) => void;
}

// Instrument the awaited boundary without adding timeout/retry semantics or changing its result.
export async function observeBiddingWork<T>(
    observer: BiddingWorkObservabilityPort | undefined,
    stage: BiddingWorkStage,
    action: () => Promise<T>,
    isSuccessful: (result: T) => boolean = () => true,
): Promise<T> {
    const finish = observeBestEffort(() => observer?.onWorkStarted?.(stage));
    let succeeded = false;
    try {
        const result = await action();
        succeeded = observeBestEffort(() => isSuccessful(result)) ?? false;
        return result;
    } finally {
        observeBestEffort(() => finish?.(succeeded));
    }
}
