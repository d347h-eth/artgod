import { describe, expect, it } from 'vitest';
import { TRADING_BIDDING_BID_BOOK_SOURCE } from '@artgod/shared/types';
import {
	bidBookFreshnessTitle,
	bidBookNextUpdateTitle,
	bidBookRefreshSignalKey,
	formatBidBookFreshness,
	formatBidBookNextUpdate
} from '$lib/bidding-bid-book-source';
import type { ApiBiddingBidBook } from '$lib/api-types';

describe('bidding bid-book source metadata', () => {
	it('formats source freshness as relative text with a UTC title', () => {
		const state: ApiBiddingBidBook['state'] = {
			source: TRADING_BIDDING_BID_BOOK_SOURCE.Orders,
			updatedAt: '2026-01-01T00:00:00Z',
			snapshotRefreshedAtMs: null,
			projectedAt: null,
			rowCount: 1,
			durationMs: null,
			lastError: null
		};

		expect(formatBidBookFreshness(state, Date.parse('2026-01-01T00:02:10Z'))).toBe('2m');
		expect(bidBookFreshnessTitle(state)).toBe('2026-01-01T00:00:00Z');
	});

	it('falls back to bot snapshot freshness when updatedAt is unavailable', () => {
		const state: ApiBiddingBidBook['state'] = {
			source: TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot,
			updatedAt: null,
			snapshotRefreshedAtMs: Date.parse('2026-01-01T00:00:00Z'),
			projectedAt: '2026-01-01T00:00:01Z',
			rowCount: 1,
			durationMs: 5,
			lastError: null
		};

		expect(formatBidBookFreshness(state, Date.parse('2026-01-01T01:00:00Z'))).toBe('1h');
		expect(bidBookFreshnessTitle(state)).toBe('2026-01-01T00:00:00Z');
	});

	it('formats the scheduled next update as relative text with a UTC title', () => {
		const nextUpdateAtMs = Date.parse('2026-01-01T00:00:05Z');

		expect(formatBidBookNextUpdate(nextUpdateAtMs, Date.parse('2026-01-01T00:00:00Z'))).toBe('5s');
		expect(bidBookNextUpdateTitle(nextUpdateAtMs)).toBe('2026-01-01T00:00:05Z');
		expect(formatBidBookNextUpdate(null, Date.parse('2026-01-01T00:00:00Z'))).toBe('-');
		expect(bidBookNextUpdateTitle(null)).toBeUndefined();
	});

	it('changes the refresh signal when the bid-book read model advances', () => {
		const firstState: ApiBiddingBidBook['state'] = {
			source: TRADING_BIDDING_BID_BOOK_SOURCE.Orders,
			updatedAt: '2026-01-01T00:00:00Z',
			snapshotRefreshedAtMs: null,
			projectedAt: null,
			rowCount: 1,
			durationMs: null,
			lastError: null
		};
		const secondState: ApiBiddingBidBook['state'] = {
			...firstState,
			updatedAt: '2026-01-01T00:00:10Z',
			rowCount: 2
		};

		expect(bidBookRefreshSignalKey(firstState)).not.toBe(bidBookRefreshSignalKey(secondState));
	});
});
