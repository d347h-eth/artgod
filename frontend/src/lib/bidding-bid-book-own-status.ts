import {
	TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE,
	TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND,
	TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT,
	resolveTradingBiddingAuthorizationJobPhase,
	TRADING_JOB_STATUS
} from '@artgod/shared/types';
import type { ApiBiddingBidBook, ApiBiddingBidBookRow, ApiBiddingJob } from '$lib/api-types';

export type BidBookOwnStatusBadge = {
	kind:
		| NonNullable<ApiBiddingBidBookRow['ownStatus']>['position']
		| NonNullable<ApiBiddingBidBookRow['ownStatus']>['constraints'][number]
		| NonNullable<ApiBiddingBidBookRow['materialization']['phase']>;
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
} as const satisfies Record<NonNullable<ApiBiddingBidBookRow['ownStatus']>['constraints'][number], string>;

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
	if (!bid.maker.isOwn) {
		return [];
	}
	if (bid.ownStatus) {
		return [
			{ kind: bid.ownStatus.position, label: bid.ownStatus.position },
			...bid.ownStatus.constraints.map((constraint) => ({
				kind: constraint,
				label: OWN_BID_CONSTRAINT_LABELS[constraint]
			}))
		];
	}
	if (bid.materialization.kind === TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent) {
		const phase = bid.materialization.phase ?? TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Queued;
		return [ownJobIntentPhaseBadge(phase)];
	}
	return [];
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
