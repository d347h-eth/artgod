import { TRADING_BIDDING_BID_BOOK_SOURCE } from '@artgod/shared/types';
import type { ApiBiddingBidBook } from '$lib/api-types';
import {
	LIVE_REFRESH_RELATIVE_TIME_TICK_MS,
	formatLiveRefreshNextUpdate,
	liveRefreshNextUpdateTitle
} from '$lib/live-refresh';

// Refreshes compact bid-book relative labels, including row times and live-refresh countdowns.
export const BID_BOOK_RELATIVE_TIME_TICK_MS = LIVE_REFRESH_RELATIVE_TIME_TICK_MS;

const BID_BOOK_REFRESH_SIGNAL_KEY_PART = {
	NoRefreshTimestamp: 'no-refresh-timestamp',
	NoProjection: 'no-projection'
} as const;

// Converts the selected bid-book source into the user-facing feed label.
export function bidBookFeedLabel(source: ApiBiddingBidBook['state']['source']): string {
	return source === TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot ? 'bidding bot' : 'indexed orders';
}

// Explains which market feed supplies the visible bid book.
export function bidBookFeedTitle(source: ApiBiddingBidBook['state']['source']): string {
	return source === TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot
		? "Bids are supplied by the bidding bot's current market feed."
		: 'Bids are supplied by OpenSea orders indexed by ArtGod.';
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
	return formatLiveRefreshNextUpdate(nextUpdateAtMs, nowMs);
}

// Formats the scheduled live-refresh timestamp as UTC for native title tooltips.
export function bidBookNextUpdateTitle(nextUpdateAtMs: number | null): string | undefined {
	return liveRefreshNextUpdateTitle(nextUpdateAtMs);
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
