export const BIDDING_SELECTION_ACTION_LABEL = {
	BidOnAllTokens: 'bid on all tokens',
	BidOnThisPage: 'bid on this page',
	BidOnToken: 'bid on token',
	BidOnTraits: 'bid on traits',
	PlaceCollectionBid: 'place collection bid',
	Activate: 'activate',
	Pause: 'pause',
	Archive: 'archive',
	Tiers: 'tiers',
	Clear: 'clear'
} as const;

export const BIDDING_SELECTION_JOB_ACTION = {
	Activate: 'activate',
	Pause: 'pause',
	Archive: 'archive'
} as const;

export type BiddingSelectionJobAction =
	(typeof BIDDING_SELECTION_JOB_ACTION)[keyof typeof BIDDING_SELECTION_JOB_ACTION];

// Keeps token-scope bidding action copy consistent across collection views.
export function resolveBiddingTokenActionLabel(input: {
	allFilteredSelectionActive: boolean;
	canRefineTokenSelectionToVisiblePage: boolean;
}): string {
	return input.allFilteredSelectionActive && input.canRefineTokenSelectionToVisiblePage
		? BIDDING_SELECTION_ACTION_LABEL.BidOnThisPage
		: BIDDING_SELECTION_ACTION_LABEL.BidOnAllTokens;
}
