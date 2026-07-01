import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import { TRADING_BIDDING_BID_BOOK_SOURCE } from '@artgod/shared/types';
import type { ApiBiddingBidBook, ApiBiddingTokenOfferCardsPage } from '$lib/api-types';

// Provides the empty bid-book shape used before a bidding surface has live data.
export function emptyBiddingBidBook(): ApiBiddingBidBook {
	return {
		state: {
			source: TRADING_BIDDING_BID_BOOK_SOURCE.Orders,
			updatedAt: null,
			snapshotRefreshedAtMs: null,
			projectedAt: null,
			rowCount: 0,
			durationMs: null,
			lastError: null
		},
		ownMakerAddress: null,
		bids: []
	};
}

// Provides the empty token-offer page shape used before the backend payload is available.
export function emptyBiddingTokenOfferCardsPage(
	limit = DEFAULT_PAGE_LIMIT
): ApiBiddingTokenOfferCardsPage {
	return {
		items: [],
		prevCursor: null,
		nextCursor: null,
		limit,
		totalItems: 0,
		marketplaceBiddingSupportedTotalItems: 0,
		totalOffers: 0,
		rangeStart: 0,
		rangeEnd: 0,
		currentPage: 0,
		totalPages: 0
	};
}
