export const BIDDING_SELECTION_ACTION_LABEL = {
	BidOnAllTokens: 'bid on all tokens',
	BidOnThisPage: 'bid on this page',
	BidOnToken: 'bid on token',
	BidOnTraits: 'bid on traits',
	PlaceCollectionBid: 'place collection bid',
	Tiers: 'tiers',
	Clear: 'clear'
} as const;

// Keeps token-scope bidding action copy consistent across collection views.
export function resolveBiddingTokenActionLabel(input: {
	allFilteredSelectionActive: boolean;
	canRefineTokenSelectionToVisiblePage: boolean;
}): string {
	return input.allFilteredSelectionActive && input.canRefineTokenSelectionToVisiblePage
		? BIDDING_SELECTION_ACTION_LABEL.BidOnThisPage
		: BIDDING_SELECTION_ACTION_LABEL.BidOnAllTokens;
}
