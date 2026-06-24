import { TRADING_BIDDING_BID_BOOK_SOURCE } from '@artgod/shared/types';
import type { ApiBiddingBidBook } from '$lib/api-types';
import { formatRfc3339 } from '$lib/compact-time-display';

// Refreshes bid-book metadata labels, including short live-refresh countdowns.
export const BID_BOOK_METADATA_RELATIVE_TIME_TICK_MS = 1_000;

const BID_BOOK_REFRESH_SIGNAL_KEY_PART = {
	NoRefreshTimestamp: 'no-refresh-timestamp',
	NoProjection: 'no-projection'
} as const;

// Converts bid-book source internals into the user-facing refresh pace label.
export function bidBookRefreshPaceLabel(source: ApiBiddingBidBook['state']['source']): string {
	return source === TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot ? 'competitive' : 'normal';
}

// Explains the refresh pace without exposing backend source names.
export function bidBookRefreshPaceTitle(source: ApiBiddingBidBook['state']['source']): string {
	const pace = bidBookRefreshPaceLabel(source);
	return `The bid book is refreshed at a ${pace} pace based on periodic orderbook polling with immediate updates from the inbound events stream.`;
}

// Resolves the best available source refresh timestamp for bid-book update signals.
export function bidBookSourceRefreshTimestampMs(state: ApiBiddingBidBook['state']): number | null {
	if (
		state.source === TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot &&
		state.snapshotRefreshedAtMs !== null
	) {
		return state.snapshotRefreshedAtMs;
	}
	if (state.updatedAt) {
		const updatedAtMs = Date.parse(state.updatedAt);
		return Number.isFinite(updatedAtMs) ? updatedAtMs : null;
	}
	return null;
}

// Formats the scheduled live-refresh countdown for bid-book metadata rows.
export function formatBidBookNextUpdate(nextUpdateAtMs: number | null, nowMs: number): string {
	if (nextUpdateAtMs === null) {
		return '-';
	}
	const secondsUntilUpdate = Math.ceil((nextUpdateAtMs - nowMs) / 1000);
	if (secondsUntilUpdate <= 0) {
		return 'now';
	}
	if (secondsUntilUpdate < 60) {
		return `${secondsUntilUpdate}s`;
	}
	if (secondsUntilUpdate < 3600) {
		return `${Math.ceil(secondsUntilUpdate / 60)}m`;
	}
	if (secondsUntilUpdate < 86_400) {
		return `${Math.ceil(secondsUntilUpdate / 3600)}h`;
	}
	return `${Math.ceil(secondsUntilUpdate / 86_400)}d`;
}

// Formats the scheduled live-refresh timestamp as UTC for native title tooltips.
export function bidBookNextUpdateTitle(nextUpdateAtMs: number | null): string | undefined {
	return nextUpdateAtMs === null ? undefined : formatRfc3339(nextUpdateAtMs);
}

// Provides a stable signal for UI effects and target lookups when bid-book data advances.
export function bidBookRefreshSignalKey(state: ApiBiddingBidBook['state']): string {
	return [
		state.source,
		bidBookSourceRefreshTimestampMs(state) ??
			BID_BOOK_REFRESH_SIGNAL_KEY_PART.NoRefreshTimestamp,
		state.projectedAt ?? BID_BOOK_REFRESH_SIGNAL_KEY_PART.NoProjection,
		state.rowCount
	].join(':');
}
