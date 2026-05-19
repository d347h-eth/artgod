import { TRADING_BIDDING_BID_BOOK_SOURCE } from '@artgod/shared/types';
import type { ApiBiddingBidBook } from '$lib/api-types';
import { formatRfc3339 } from '$lib/compact-time-display';

// Converts bid-book source internals into the user-facing refresh pace label.
export function bidBookRefreshPaceLabel(source: ApiBiddingBidBook['state']['source']): string {
	return source === TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot ? 'competitive' : 'normal';
}

// Explains the refresh pace without exposing backend source names.
export function bidBookRefreshPaceTitle(source: ApiBiddingBidBook['state']['source']): string {
	const pace = bidBookRefreshPaceLabel(source);
	return `The bid book is refreshed at a ${pace} pace based on periodic orderbook polling with immediate updates from the inbound events stream.`;
}

// Formats the best available source freshness timestamp for bid-book metadata rows.
export function formatBidBookFreshness(state: ApiBiddingBidBook['state']): string {
	if (state.updatedAt) {
		const updatedAtMs = Date.parse(state.updatedAt);
		return Number.isFinite(updatedAtMs) ? formatRfc3339(updatedAtMs) : state.updatedAt;
	}
	if (
		state.source === TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot &&
		state.snapshotRefreshedAtMs !== null
	) {
		return formatRfc3339(state.snapshotRefreshedAtMs);
	}
	return '-';
}
