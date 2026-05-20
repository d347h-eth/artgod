import {
	TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE,
	TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND
} from '@artgod/shared/types';
import type { ApiBiddingBidBookRow } from '$lib/api-types';

export type BidBookOwnStatusBadge = {
	kind:
		| NonNullable<ApiBiddingBidBookRow['ownStatus']>['position']
		| NonNullable<ApiBiddingBidBookRow['ownStatus']>['constraints'][number]
		| NonNullable<ApiBiddingBidBookRow['materialization']['phase']>;
	label: string;
};

const OWN_JOB_INTENT_PHASE_LABELS = {
	[TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.ActiveOrder]: 'active',
	[TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Paused]: 'paused',
	[TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Queued]: 'queued'
} as const;

// Builds the compact own-bid badges shared by table rows and token offer cards.
export function ownBidStatusBadges(bid: ApiBiddingBidBookRow): BidBookOwnStatusBadge[] {
	if (!bid.maker.isOwn) {
		return [];
	}
	if (bid.materialization.kind === TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent) {
		const phase = bid.materialization.phase ?? TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Queued;
		return [
			{
				kind: phase,
				label: OWN_JOB_INTENT_PHASE_LABELS[phase]
			}
		];
	}
	if (!bid.ownStatus) {
		return [];
	}
	return [
		{ kind: bid.ownStatus.position, label: bid.ownStatus.position },
		...bid.ownStatus.constraints.map((constraint) => ({
			kind: constraint,
			label: constraint
		}))
	];
}
