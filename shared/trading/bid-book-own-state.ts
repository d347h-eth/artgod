import {
    COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTERS,
    TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE,
    TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND,
    isCollectionBiddingBidBookOwnStateFilter,
    type CollectionBiddingBidBookOwnStateFilter,
    type TradingBiddingBidBookOwnJobPhase,
    type TradingBiddingBidBookOwnState,
    type TradingBiddingBidBookOwnStateCounts,
    type TradingBiddingBidBookRowMaterializationKind,
    type TradingBiddingJobRuntimeBidPosition,
    type TradingBiddingJobRuntimeConstraint,
} from "../types/trading.js";

// Transport-neutral bid-book signals. Callers map ownership at their adapter boundary.
export type BiddingBidBookOwnStateSignals = {
    isOwn: boolean;
    ownStatus: {
        position: TradingBiddingJobRuntimeBidPosition;
        constraints: readonly TradingBiddingJobRuntimeConstraint[];
    } | null;
    materialization: {
        kind: TradingBiddingBidBookRowMaterializationKind;
        phase: TradingBiddingBidBookOwnJobPhase | null;
    };
};

// Preserve badge precedence: a bot-owned decision supersedes the pending intent phase.
export function biddingBidBookOwnStates(
    bid: BiddingBidBookOwnStateSignals,
): TradingBiddingBidBookOwnState[] {
    if (!bid.isOwn) return [];
    if (bid.ownStatus) {
        return [bid.ownStatus.position, ...new Set(bid.ownStatus.constraints)];
    }
    if (
        bid.materialization.kind ===
        TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent
    ) {
        return [
            bid.materialization.phase ??
                TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Queued,
        ];
    }
    return [];
}

export function bidMatchesOwnStateFilter(
    bid: BiddingBidBookOwnStateSignals,
    state: CollectionBiddingBidBookOwnStateFilter | null,
): boolean {
    return state === null || biddingBidBookOwnStates(bid).includes(state);
}

// One count per own bid row and matching badge. Total includes own rows with other or unavailable states.
export function countBiddingBidBookOwnStates(
    bids: Iterable<BiddingBidBookOwnStateSignals>,
): TradingBiddingBidBookOwnStateCounts {
    const counts: TradingBiddingBidBookOwnStateCounts = {
        total: 0,
        states: Object.fromEntries(
            COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTERS.map((state) => [
                state,
                0,
            ]),
        ) as TradingBiddingBidBookOwnStateCounts["states"],
    };
    for (const bid of bids) {
        if (!bid.isOwn) continue;
        counts.total += 1;
        for (const state of biddingBidBookOwnStates(bid)) {
            if (isCollectionBiddingBidBookOwnStateFilter(state)) {
                counts.states[state] += 1;
            }
        }
    }
    return counts;
}
