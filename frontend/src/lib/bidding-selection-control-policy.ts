import {
	COLLECTION_BIDDING_BID_SCOPE_FILTER,
	type CollectionBiddingBidScopeFilter
} from '@artgod/shared/types';

export type BiddingSelectionControlPolicy = {
	renderRow: boolean;
	showTraitAction: boolean;
	showTokenAction: boolean;
	showCollectionAction: boolean;
	showTierAction: boolean;
};

// Resolves bidding action-row visibility for normal token-browser pages.
export function resolveTokenBrowserBiddingSelectionControlPolicy(params: {
	publicSingleCollection: boolean;
	canBidOnTraits: boolean;
}): BiddingSelectionControlPolicy {
	return {
		renderRow: !params.publicSingleCollection,
		showTraitAction: params.canBidOnTraits,
		showTokenAction: true,
		showCollectionAction: false,
		showTierAction: true
	};
}

// Resolves bidding action-row visibility for collection offers/bid-book pages.
export function resolveCollectionBiddingSelectionControlPolicy(params: {
	publicSingleCollection: boolean;
	bidScope: CollectionBiddingBidScopeFilter;
	canBidOnTraits: boolean;
	hasSelectionSummary: boolean;
}): BiddingSelectionControlPolicy {
	if (params.bidScope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection) {
		return {
			renderRow: !params.publicSingleCollection,
			showTraitAction: false,
			showTokenAction: false,
			showCollectionAction: true,
			showTierAction: true
		};
	}

	const showTokenAction = params.bidScope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token;
	return {
		renderRow: showTokenAction || params.canBidOnTraits || params.hasSelectionSummary,
		showTraitAction: params.canBidOnTraits,
		showTokenAction,
		showCollectionAction: false,
		showTierAction: !params.publicSingleCollection
	};
}
