import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import type { ApiBiddingTokenOfferCardsPage } from '$lib/api-types';

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
		totalOffers: 0,
		rangeStart: 0,
		rangeEnd: 0,
		currentPage: 0,
		totalPages: 0
	};
}
