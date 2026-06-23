import { TRADING_BIDDING_BID_BOOK_SOURCE } from '@artgod/shared/types';
import type { ApiBiddingBidBook } from '$lib/api-types';
import { formatCompactRelativeTime, formatRfc3339 } from '$lib/compact-time-display';

// Refreshes bid-book relative freshness labels without coupling them to data polling cadence.
export const BID_BOOK_FRESHNESS_RELATIVE_TIME_TICK_MS = 30_000;

// Converts bid-book source internals into the user-facing refresh pace label.
export function bidBookRefreshPaceLabel(source: ApiBiddingBidBook['state']['source']): string {
	return source === TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot ? 'competitive' : 'normal';
}

// Explains the refresh pace without exposing backend source names.
export function bidBookRefreshPaceTitle(source: ApiBiddingBidBook['state']['source']): string {
	const pace = bidBookRefreshPaceLabel(source);
	return `The bid book is refreshed at a ${pace} pace based on periodic orderbook polling with immediate updates from the inbound events stream.`;
}

// Resolves the best available source freshness timestamp for bid-book metadata rows.
export function bidBookFreshnessTimestampMs(state: ApiBiddingBidBook['state']): number | null {
	if (state.updatedAt) {
		const updatedAtMs = Date.parse(state.updatedAt);
		return Number.isFinite(updatedAtMs) ? updatedAtMs : null;
	}
	if (
		state.source === TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot &&
		state.snapshotRefreshedAtMs !== null
	) {
		return state.snapshotRefreshedAtMs;
	}
	return null;
}

// Formats bid-book source freshness as a relative age for metadata rows.
export function formatBidBookFreshness(state: ApiBiddingBidBook['state'], nowMs: number): string {
	const freshnessMs = bidBookFreshnessTimestampMs(state);
	return freshnessMs === null ? '-' : formatCompactRelativeTime(freshnessMs, nowMs);
}

// Formats bid-book source freshness as UTC for native title tooltips.
export function bidBookFreshnessTitle(state: ApiBiddingBidBook['state']): string | undefined {
	const freshnessMs = bidBookFreshnessTimestampMs(state);
	return freshnessMs === null ? undefined : formatRfc3339(freshnessMs);
}
