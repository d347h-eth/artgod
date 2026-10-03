import {
    COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTERS,
    TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE,
    TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND,
    TRADING_BIDDING_BID_BOOK_OWN_STATE,
    TRADING_JOB_STATUS,
    type CollectionBiddingBidBookOwnStateFilter,
    type TradingBiddingBidBookOwnJobPhase,
    type TradingBiddingBidBookOwnState,
    type TradingBiddingBidBookOwnStateCounts,
    type TradingBiddingBidBookRowMaterializationKind,
    type TradingBiddingJobRuntimeBidPosition,
    type TradingBiddingJobRuntimeConstraint,
    type TradingJobStatus,
} from "../types/trading.js";

// Transport-neutral bid-book signals. Callers map ownership at their adapter boundary.
export type BiddingBidBookOwnStateSignals = {
    isOwn: boolean;
    ownStatus: {
        position: TradingBiddingJobRuntimeBidPosition;
        constraints: readonly TradingBiddingJobRuntimeConstraint[];
        job: { status: TradingJobStatus } | null;
    } | null;
    materialization: {
        kind: TradingBiddingBidBookRowMaterializationKind;
        phase: TradingBiddingBidBookOwnJobPhase | null;
        status: TradingJobStatus | null;
    };
};

// One classifier owns badges, filters and counts. Declared pause is independent
// of the offer lifecycle; current bot decisions supersede pending intent phases.
// Every own row has at least one state, without guessing market competitiveness.
export function biddingBidBookOwnStates(
    bid: BiddingBidBookOwnStateSignals,
): TradingBiddingBidBookOwnState[] {
    if (!bid.isOwn) return [];
    const states: TradingBiddingBidBookOwnState[] = [];
    const jobStatus = bid.materialization.status ?? bid.ownStatus?.job?.status;
    if (jobStatus === TRADING_JOB_STATUS.Paused) {
        states.push(TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Paused);
    }
    if (bid.ownStatus) {
        states.push(bid.ownStatus.position, ...bid.ownStatus.constraints);
    } else if (
        bid.materialization.kind ===
        TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent
    ) {
        states.push(
            bid.materialization.phase ??
                TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Queued,
        );
    }
    return states.length > 0
        ? [...new Set(states)]
        : [TRADING_BIDDING_BID_BOOK_OWN_STATE.Unknown];
}

export function bidMatchesOwnStateFilter(
    bid: BiddingBidBookOwnStateSignals,
    state: CollectionBiddingBidBookOwnStateFilter | null,
): boolean {
    return state === null || biddingBidBookOwnStates(bid).includes(state);
}

// Ownership is applied by the caller before state selection. Matching own rows
// anchor groups whose opponent rows remain available as market context. Other
// own states and groups without a match are excluded, preserving empty results.
export function filterBiddingBidBookRowsByOwnState<
    Row extends BiddingBidBookOwnStateSignals,
>(
    rows: Row[],
    state: CollectionBiddingBidBookOwnStateFilter | null,
    groupKey: (row: Row) => string,
): Row[] {
    if (state === null) return rows;
    const matchingOwnRows = new Set<Row>();
    const matchingGroups = new Set<string>();
    for (const row of rows) {
        if (bidMatchesOwnStateFilter(row, state)) {
            matchingOwnRows.add(row);
            matchingGroups.add(groupKey(row));
        }
    }
    return rows.filter(
        (row) =>
            matchingOwnRows.has(row) ||
            (!row.isOwn && matchingGroups.has(groupKey(row))),
    );
}

// One count per own bid row and matching badge. All is the union of state matches,
// rather than their sum: positions, constraints and declared pause can overlap.
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
            counts.states[state] += 1;
        }
    }
    return counts;
}
