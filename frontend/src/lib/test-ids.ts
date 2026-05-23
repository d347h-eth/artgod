// Stable selectors for browser-driven tests where accessible names are repeated.
export const TEST_IDS = {
	BiddingPanel: 'bidding-panel',
	BiddingPanelCreate: 'bidding-panel-create',
	BiddingPanelModify: 'bidding-panel-modify',
	BiddingPanelActivate: 'bidding-panel-activate',
	BiddingPanelPause: 'bidding-panel-pause',
	BiddingPanelArchive: 'bidding-panel-archive',
	BidBookTraitBucketBid: 'bid-book-trait-bucket-bid',
	BidBookTraitBucketFilter: 'bid-book-trait-bucket-filter',
	BidBookRowBid: 'bid-book-row-bid',
	BidBookRowFilter: 'bid-book-row-filter',
	TokenCard: 'token-card',
	TokenCardBiddingToggle: 'token-card-bidding-toggle'
} as const;
