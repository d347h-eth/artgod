import {
	ACTIVITY_KIND,
	ACTIVITY_SCOPE_KIND,
	ACTIVITY_SOURCE_KIND,
	ACTIVITY_FEED_FILTER_KIND,
	LISTING_HISTORY_POLICY
} from '@artgod/shared/types';
import { MARKET_DATA_STORAGE_POLICY as POLICY } from '@artgod/shared/market-data/storage-policy';
import { PAGINATION_QUERY_PARAMS } from '@artgod/shared/config/pagination';
import type { ApiActivitiesPage } from '$lib/api-types';
import { buildBiddingE2eCollectionDetailData } from './bidding-automation-fixtures';
import { LISTING_HISTORY_HARNESS } from './listing-history-contract';

/** Production activity view: daily price, same-day update, expired order and empty history. */
export function buildListingHistoryFixture(params: URLSearchParams) {
	const collection = buildBiddingE2eCollectionDetailData(new URLSearchParams());
	const empty = params.has(LISTING_HISTORY_HARNESS.emptyKey);
	const older =
		params.get(PAGINATION_QUERY_PARAMS.Cursor) === LISTING_HISTORY_HARNESS.pageTwoCursor;
	const pinned = 1_726_000_200 - (older ? POLICY.utcDaySeconds : 0);
	const dayStart = Math.floor(pinned / POLICY.utcDaySeconds) * POLICY.utcDaySeconds;
	const unavailable = params.has(LISTING_HISTORY_HARNESS.unavailableKey);
	const updated = params.has(LISTING_HISTORY_HARNESS.updatedKey);
	const activities: ApiActivitiesPage = {
		items: empty
			? []
			: [
					{
						id: older ? 2 : 1,
						scopeKind: ACTIVITY_SCOPE_KIND.Token,
						kind: ACTIVITY_KIND.ListingCreated,
						contract: collection.collection.address,
						tokenId: '104',
						occurredAt: pinned,
						sourceKind: ACTIVITY_SOURCE_KIND.Offchain,
						sourceName: 'opensea',
						orderId: unavailable ? null : 'fixture-order',
						blockNumber: null,
						txHash: null,
						logIndex: null,
						from: null,
						to: null,
						maker: '0x1111111111111111111111111111111111111111',
						taker: null,
						side: 'sell',
						amount: '1',
						price: updated || unavailable ? '50000000000000000' : '100000000000000000',
						currency: '0x0000000000000000000000000000000000000000',
						payload: null,
						isCollapsed: true,
						collapsedEventCount: null,
						collapsedWindowStartUtc: dayStart,
						collapsedWindowEndUtc: dayStart + POLICY.utcDaySeconds - 1
					}
				],
		prevCursor: null,
		nextCursor: empty || older ? null : LISTING_HISTORY_HARNESS.pageTwoCursor,
		limit: 1,
		totalItems: empty ? 0 : 2,
		rangeStart: empty ? 0 : older ? 2 : 1,
		rangeEnd: empty ? 0 : older ? 2 : 1,
		currentPage: empty ? 0 : older ? 2 : 1,
		totalPages: empty ? 0 : 2,
		listingHistory: LISTING_HISTORY_POLICY
	};
	return {
		...collection,
		activities,
		filterKind: ACTIVITY_FEED_FILTER_KIND.Listings,
		basePath: collection.basePath,
		included: { tokensById: {}, eventMediaByActivityId: {}, hasTraitSummaryTemplate: false }
	};
}
