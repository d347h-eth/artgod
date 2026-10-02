import {
	COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTERS,
	TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE,
	TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND,
	TRADING_BIDDING_JOB_RUNTIME_BID_POSITION,
	TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT,
	resolveTradingBiddingAuthorizationJobPhase,
	TRADING_JOB_STATUS,
	type CollectionBiddingBidBookOwnStateFilter,
	type TradingBiddingBidBookOwnState,
	type TradingBiddingBidBookOwnStateCounts
} from '@artgod/shared/types';
import {
	biddingBidBookOwnStates,
	type BiddingBidBookOwnStateSignals
} from '@artgod/shared/trading/bid-book-own-state';
import { BID_BOOK_FILTER_ALL_LABEL, type BidBookFilterTab } from '$lib/bid-book-view-models';
import type { ApiBiddingBidBook, ApiBiddingBidBookRow, ApiBiddingJob } from '$lib/api-types';

export type BidBookOwnStatusBadge = {
	kind: TradingBiddingBidBookOwnState;
	label: string;
};

const OWN_JOB_INTENT_PHASE_LABELS = {
	[TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Cancelled]: 'cancelled',
	[TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.CancelFailed]: 'cancel failed',
	[TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Canceling]: 'canceling',
	[TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.AuthorizationRequired]: 'authorization required',
	[TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.AuthorizationUnavailable]: 'authorization unavailable',
	[TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Paused]: 'paused',
	[TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Queued]: 'queued',
	[TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.WaitingForBot]: 'waiting for bidding bot',
	[TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Verifying]: 'verifying',
	[TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Replacing]: 'replacing'
} as const;

const OWN_BID_CONSTRAINT_LABELS = {
	[TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling]: 'hit ceiling',
	[TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Floor]: 'at floor'
} as const satisfies Record<
	NonNullable<ApiBiddingBidBookRow['ownStatus']>['constraints'][number],
	string
>;

const OWN_BID_STATE_LABELS = {
	...OWN_JOB_INTENT_PHASE_LABELS,
	...OWN_BID_CONSTRAINT_LABELS,
	[TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Winning]:
		TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Winning,
	[TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing]:
		TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
	[TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Draw]: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Draw
} as const satisfies Record<TradingBiddingBidBookOwnState, string>;

function ownJobIntentPhaseBadge(
	phase: NonNullable<ApiBiddingBidBookRow['materialization']['phase']>
): BidBookOwnStatusBadge {
	return {
		kind: phase,
		label: OWN_JOB_INTENT_PHASE_LABELS[phase]
	};
}

// Builds the compact own-bid badges shared by table rows and token offer cards.
export function ownBidStatusBadges(bid: ApiBiddingBidBookRow): BidBookOwnStatusBadge[] {
	return biddingBidBookOwnStates(bidBookOwnStateSignals(bid)).map((kind) => ({
		kind,
		label: ownBidStateLabel(kind)
	}));
}

// Map the API ownership envelope to the shared state contract at the frontend boundary.
export function bidBookOwnStateSignals(bid: ApiBiddingBidBookRow): BiddingBidBookOwnStateSignals {
	return { isOwn: bid.maker.isOwn, ownStatus: bid.ownStatus, materialization: bid.materialization };
}

function ownBidStateLabel(kind: TradingBiddingBidBookOwnState): string {
	return OWN_BID_STATE_LABELS[kind];
}

// Compact filter labels refer to the same states as the existing row badges.
export function ownBidStateFilterTabs(
	counts: TradingBiddingBidBookOwnStateCounts,
	activeState: CollectionBiddingBidBookOwnStateFilter | null
): BidBookFilterTab<CollectionBiddingBidBookOwnStateFilter>[] {
	return [
		{
			key: null,
			label: BID_BOOK_FILTER_ALL_LABEL,
			count: counts.total,
			active: activeState === null
		},
		...COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTERS.map((key) => ({
			key,
			label:
				key === TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.WaitingForBot
					? 'waiting for bot'
					: key === TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling
						? 'at ceiling'
						: ownBidStateLabel(key),
			count: counts.states[key],
			active: key === activeState
		}))
	];
}

// Resolves the user-facing state badges for the bidding panel from backend-owned bid-book signals.
export function ownBiddingJobStateBadges(
	job: ApiBiddingJob | null,
	bidBook: ApiBiddingBidBook | null
): BidBookOwnStatusBadge[] {
	if (!job) {
		return [];
	}
	const authorizationPhase =
		job.status === TRADING_JOB_STATUS.Enabled && bidBook?.biddingAuthorization
			? resolveTradingBiddingAuthorizationJobPhase(bidBook.biddingAuthorization.status)
			: null;
	if (authorizationPhase) {
		return [ownJobIntentPhaseBadge(authorizationPhase)];
	}

	const marketBid = bidBook?.bids.find(
		(bid) => bid.maker.isOwn && bid.ownStatus?.job?.jobId === job.jobId
	);
	if (marketBid) {
		return ownBidStatusBadges(marketBid);
	}

	const ownIntentBid = bidBook?.bids.find(
		(bid) =>
			bid.maker.isOwn &&
			bid.materialization.kind === TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent &&
			bid.materialization.jobId === job.jobId
	);
	if (ownIntentBid) {
		return ownBidStatusBadges(ownIntentBid);
	}

	if (job.status === TRADING_JOB_STATUS.Archived) {
		return [];
	}

	if (job.status === TRADING_JOB_STATUS.Paused) {
		return [ownJobIntentPhaseBadge(TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Paused)];
	}

	return [ownJobIntentPhaseBadge(TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Queued)];
}
