import { describe, expect, it } from 'vitest';
import { TRADING_BIDDING_BID_BOOK_SOURCE } from '@artgod/shared/types';
import type { ApiBiddingBidBook } from '$lib/api-types';
import { resolveBiddingAutomationPanelTargetLookupRequestKey } from '$lib/bidding-automation-panel-state';

const TARGET_LOOKUP_KEY = 'ethereum:milady:trait:Biome=42';

describe('bidding automation panel state', () => {
	it('invalidates target lookup requests when the bid-book refresh signal changes', () => {
		const firstBidBook = testBidBook('2026-01-01T00:00:00Z', 1);
		const secondBidBook = testBidBook('2026-01-01T00:00:10Z', 2);

		const firstKey = resolveBiddingAutomationPanelTargetLookupRequestKey({
			targetLookupKey: TARGET_LOOKUP_KEY,
			bidBook: firstBidBook
		});
		const secondKey = resolveBiddingAutomationPanelTargetLookupRequestKey({
			targetLookupKey: TARGET_LOOKUP_KEY,
			bidBook: secondBidBook
		});

		expect(firstKey).not.toBe(secondKey);
		expect(firstKey).toContain(TARGET_LOOKUP_KEY);
	});

	it('does not request target lookups when there is no lookup target', () => {
		expect(
			resolveBiddingAutomationPanelTargetLookupRequestKey({
				targetLookupKey: '',
				bidBook: testBidBook('2026-01-01T00:00:00Z', 1)
			})
		).toBe('');
	});
});

function testBidBook(updatedAt: string, rowCount: number): ApiBiddingBidBook {
	return {
		state: {
			source: TRADING_BIDDING_BID_BOOK_SOURCE.Orders,
			updatedAt,
			snapshotRefreshedAtMs: null,
			projectedAt: null,
			rowCount,
			durationMs: null,
			lastError: null
		},
		ownMakerAddress: null,
		bids: []
	};
}
