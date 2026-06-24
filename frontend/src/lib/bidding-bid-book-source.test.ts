import { describe, expect, it } from 'vitest';
import { TRADING_BIDDING_BID_BOOK_SOURCE } from '@artgod/shared/types';
import {
	bidBookNextUpdateTitle,
	bidBookRefreshSignalKey,
	bidBookSourceRefreshTimestampMs,
	formatBidBookNextUpdate
} from '$lib/bidding-bid-book-source';
import type { ApiBiddingBidBook } from '$lib/api-types';

describe('bidding bid-book source metadata', () => {
	it('resolves order-backed source refresh timestamps from updatedAt', () => {
		const state: ApiBiddingBidBook['state'] = {
			source: TRADING_BIDDING_BID_BOOK_SOURCE.Orders,
			updatedAt: '2026-01-01T00:00:00Z',
			snapshotRefreshedAtMs: null,
			projectedAt: null,
			rowCount: 1,
			durationMs: null,
			lastError: null
		};

		expect(bidBookSourceRefreshTimestampMs(state)).toBe(Date.parse('2026-01-01T00:00:00Z'));
	});

	it('resolves bot snapshot source refresh timestamps from snapshot state', () => {
		const state: ApiBiddingBidBook['state'] = {
			source: TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot,
			updatedAt: null,
			snapshotRefreshedAtMs: Date.parse('2026-01-01T00:00:00Z'),
			projectedAt: '2026-01-01T00:00:01Z',
			rowCount: 1,
			durationMs: 5,
			lastError: null
		};

		expect(bidBookSourceRefreshTimestampMs(state)).toBe(Date.parse('2026-01-01T00:00:00Z'));
	});

	it('prefers bot snapshot refresh timestamps over source updatedAt', () => {
		const state: ApiBiddingBidBook['state'] = {
			source: TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot,
			updatedAt: '2026-01-01T00:00:00Z',
			snapshotRefreshedAtMs: Date.parse('2026-01-01T00:00:55Z'),
			projectedAt: '2026-01-01T00:00:56Z',
			rowCount: 1,
			durationMs: 5,
			lastError: null
		};

		expect(bidBookSourceRefreshTimestampMs(state)).toBe(Date.parse('2026-01-01T00:00:55Z'));
	});

	it('formats the scheduled next refresh as relative text with a UTC title', () => {
		const nextUpdateAtMs = Date.parse('2026-01-01T00:00:05Z');

		expect(formatBidBookNextUpdate(nextUpdateAtMs, Date.parse('2026-01-01T00:00:00Z'))).toBe('5s');
		expect(formatBidBookNextUpdate(nextUpdateAtMs, Date.parse('2026-01-01T00:00:01Z'))).toBe('4s');
		expect(formatBidBookNextUpdate(nextUpdateAtMs, Date.parse('2026-01-01T00:00:04Z'))).toBe('1s');
		expect(formatBidBookNextUpdate(nextUpdateAtMs, Date.parse('2026-01-01T00:00:05Z'))).toBe('now');
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
