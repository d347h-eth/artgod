import { describe, expect, it } from 'vitest';
import {
	TRADING_BIDDING_BID_BOOK_PRICE_KIND,
	TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND,
	TRADING_BIDDING_BID_BOOK_SOURCE,
	TRADING_BIDDING_BID_SCOPE_KIND,
	TRADING_BIDDING_JOB_RUNTIME_BID_POSITION,
	TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT,
	TRADING_JOB_STATUS
} from '@artgod/shared/types';
import type { ApiBiddingBidBookRow } from '$lib/api-types';
import { bidBookOwnRowFlashKey } from '$lib/bid-book-update-flash';

describe('bid-book update flash', () => {
	it('keeps passive snapshot timestamp changes out of own-row flash keys', () => {
		const bid = testOwnBid();

		expect(bidBookOwnRowFlashKey(bid)).toBe(
			bidBookOwnRowFlashKey({
				...bid,
				snapshotRefreshedAtMs: Date.parse('2026-01-01T00:00:05Z')
			})
		);
	});

	it('changes own-row flash keys when runtime state changes', () => {
		const bid = testOwnBid();

		expect(bidBookOwnRowFlashKey(bid)).not.toBe(
			bidBookOwnRowFlashKey({
				...bid,
				ownStatus: {
					position: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
					constraints: [TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling],
					job: {
						jobId: 'job-token-1',
						revision: 2,
						status: TRADING_JOB_STATUS.Enabled
					}
				}
			})
		);
	});
});

function testOwnBid(): ApiBiddingBidBookRow {
	return {
		orderId: '0xown',
		source: TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot,
		materialization: {
			kind: TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.MarketBid,
			jobId: null,
			status: null,
			phase: null
		},
		scope: {
			kind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
			label: '#1',
			tokenId: '1',
			traits: []
		},
		maker: {
			address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			label: 'You',
			isOwn: true
		},
		price: {
			kind: TRADING_BIDDING_BID_BOOK_PRICE_KIND.Exact,
			wei: '100000000000000000',
			eth: '0.1'
		},
		quantity: '1',
		currencyAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
		currencySymbol: 'WETH',
		protocolAddress: null,
		validUntil: 1_900_000_000,
		placedAt: '2026-01-01T00:00:00Z',
		snapshotRefreshedAtMs: Date.parse('2026-01-01T00:00:00Z'),
		seenAt: '2026-01-01T00:00:00Z',
		ownStatus: null
	};
}
