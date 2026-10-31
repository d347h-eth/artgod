import {
    COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER,
    COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTERS,
    COLLECTION_BIDDING_BID_SCOPE_FILTER,
    TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE,
    TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND,
    TRADING_BIDDING_BID_BOOK_OWN_STATE,
    TRADING_JOB_STATUS,
    TRADING_BIDDING_JOB_PRICING_SOURCE_KIND,
    type CollectionBiddingBidBookPriceTierFilter,
    type TradingBiddingBidBookOwnJob,
    type TradingBiddingBidBookPriceTier,
    type TradingBiddingBidBookPriceTierCounts,
    type CollectionBiddingBidBookOwnStateFilter,
    type CollectionBiddingBidScopeFilter,
    type TradingBiddingBidBookOwnJobPhase,
    type TradingBiddingBidBookOwnState,
    type TradingBiddingBidBookOwnStateCounts,
    type TradingBiddingBidBookRowMaterializationKind,
    type TradingBiddingJobRuntimeBidPosition,
    type TradingBiddingJobRuntimeConstraint,
    type TradingJobStatus,
} from "../types/trading.js";
import { ReadModelBadRequestError } from "../read-models/errors.js";

// Saved order evidence survives a boot without authorization. Verification is
// pending only when the current runtime can actually perform it.
export function resolveBiddingBidBookOrderPhase(input: {
    verified: boolean;
    verificationExpected: boolean;
    verifiedPhase:
        | typeof TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Queued
        | typeof TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Replacing;
}): TradingBiddingBidBookOwnJobPhase {
    if (input.verified) return input.verifiedPhase;
    return input.verificationExpected
        ? TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Verifying
        : TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Unconfirmed;
}

export function isBiddingBidBookCancellationPhase(
    phase: TradingBiddingBidBookOwnJobPhase | null | undefined,
): boolean {
    return (
        phase === TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Canceling ||
        phase === TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.CancelFailed ||
        phase === TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Cancelled
    );
}

// These phases describe a tracked order rather than a declaration awaiting
// execution. Panels must retain them when an edited job also has an intent row.
export function isBiddingBidBookOrderLifecyclePhase(
    phase: TradingBiddingBidBookOwnJobPhase | null | undefined,
): boolean {
    return (
        isBiddingBidBookCancellationPhase(phase) ||
        phase === TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Unconfirmed ||
        phase === TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Verifying ||
        phase === TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Replacing
    );
}

// Own-state selection belongs to the token and trait bid-book views, which expose
// the selected filter and its reset control. Keep URL building and API validation aligned.
export function bidScopeSupportsOwnStateFilter(
    scope: CollectionBiddingBidScopeFilter,
): boolean {
    return (
        scope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token ||
        scope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits
    );
}

// Invalid scoped reads fail before loading a bid book, rather than applying a
// filter that its view cannot display and its next refresh would discard.
export function assertBidScopeSupportsOwnStateFilter(
    scope: CollectionBiddingBidScopeFilter,
): void {
    if (!bidScopeSupportsOwnStateFilter(scope)) {
        throw new ReadModelBadRequestError(
            "Use token or trait bids to filter by own bid state",
        );
    }
}

// Transport-neutral bid-book signals. Callers map ownership at their adapter boundary.
export type BiddingBidBookOwnStateSignals = {
    isOwn: boolean;
    ownJob?: TradingBiddingBidBookOwnJob | null;
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
    return state === null || ownBidStateFilters(bid).includes(state);
}

// Active includes every own row outside the paused category. Reuse that category
// so declared pause during cancellation and pause reported by intent stay aligned.
// Keep this aggregate out of badge classification.
function ownBidStateFilters(
    bid: BiddingBidBookOwnStateSignals,
): CollectionBiddingBidBookOwnStateFilter[] {
    const states = biddingBidBookOwnStates(bid);
    return states.length > 0 &&
        !states.includes(TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Paused)
        ? [COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER.Active, ...states]
        : states;
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
    return filterBiddingBidBookRowsByOwnFilters(
        rows,
        { ownStateFilter: state },
        groupKey,
    );
}

export type BiddingBidBookOwnFilters = {
    ownStateFilter?: CollectionBiddingBidBookOwnStateFilter | null;
    priceTierFilter?: CollectionBiddingBidBookPriceTierFilter | null;
};

// A missing job association is unknown pricing, never an ad-hoc manual job.
export function bidMatchesPriceTierFilter(
    bid: BiddingBidBookOwnStateSignals,
    tier: CollectionBiddingBidBookPriceTierFilter | null,
): boolean {
    if (tier === null) return true;
    if (!bid.isOwn || !bid.ownJob) return false;
    return tier === TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.Manual
        ? bid.ownJob.priceTierId === null
        : bid.ownJob.priceTierId === tier;
}

// Both selections must match one own row before expanding its opponent context.
export function filterBiddingBidBookRowsByOwnFilters<
    Row extends BiddingBidBookOwnStateSignals,
>(
    rows: Row[],
    filters: BiddingBidBookOwnFilters,
    groupKey: (row: Row) => string,
): Row[] {
    if (!filters.ownStateFilter && !filters.priceTierFilter) return rows;
    const matchingOwnRows = new Set<Row>();
    const matchingGroups = new Set<string>();
    for (const row of rows) {
        if (
            row.isOwn &&
            bidMatchesOwnStateFilter(row, filters.ownStateFilter ?? null) &&
            bidMatchesPriceTierFilter(row, filters.priceTierFilter ?? null)
        ) {
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

// Shared normalization for URL and structured batch-selection boundaries.
export function parseBiddingBidBookPriceTierFilter(
    value: unknown,
): CollectionBiddingBidBookPriceTierFilter | null {
    if (value === null || value === undefined) return null;
    if (
        typeof value !== "string" ||
        !value.trim() ||
        value.trim().length > 128
    ) {
        throw new ReadModelBadRequestError(
            "price_tier must be manual or a collection price-tier id",
        );
    }
    return value.trim();
}

// Each facet ignores its own selection. Callers supply rows after scope/trait/bidder
// matching and before pagination; stream those rows once for both summaries.
export function countBiddingBidBookOwnFilters(
    rows: Iterable<BiddingBidBookOwnStateSignals>,
    filters: BiddingBidBookOwnFilters,
    tiers: readonly TradingBiddingBidBookPriceTier[] = [],
): {
    ownBidStateCounts: TradingBiddingBidBookOwnStateCounts;
    ownPriceTierCounts: TradingBiddingBidBookPriceTierCounts;
} {
    const ownBidStateCounts = countBiddingBidBookOwnStates([]);
    const ownPriceTierCounts: TradingBiddingBidBookPriceTierCounts = {
        manual: 0,
        tiers: tiers.map((tier) => ({ ...tier, count: 0 })),
    };
    const tiersById = new Map(
        ownPriceTierCounts.tiers.map((tier) => [tier.tierId, tier]),
    );
    for (const row of rows) {
        if (!row.isOwn) continue;
        if (bidMatchesPriceTierFilter(row, filters.priceTierFilter ?? null)) {
            addOwnBidStateCounts(ownBidStateCounts, row);
        }
        if (
            row.ownJob &&
            bidMatchesOwnStateFilter(row, filters.ownStateFilter ?? null)
        ) {
            if (row.ownJob.priceTierId === null) ownPriceTierCounts.manual++;
            else {
                const tier = tiersById.get(row.ownJob.priceTierId);
                if (tier) tier.count++;
            }
        }
    }
    return { ownBidStateCounts, ownPriceTierCounts };
}

// One count per own row and matching filter before selection or pagination.
// Active and paused partition total; other state matches can overlap.
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
        addOwnBidStateCounts(counts, bid);
    }
    return counts;
}

function addOwnBidStateCounts(
    counts: TradingBiddingBidBookOwnStateCounts,
    bid: BiddingBidBookOwnStateSignals,
): void {
    counts.total++;
    for (const state of ownBidStateFilters(bid)) counts.states[state]++;
}
