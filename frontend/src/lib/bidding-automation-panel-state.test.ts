import { describe, expect, it } from 'vitest';
import {
	TRADING_BIDDING_BID_BOOK_PRICE_KIND,
	TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND,
	TRADING_BIDDING_BID_BOOK_SOURCE,
	TRADING_BIDDING_BID_SCOPE_KIND,
	TRADING_BOT_LIFECYCLE_STATUS,
	TRADING_JOB_STATUS,
	TRADING_JOB_TARGET_KIND
} from '@artgod/shared/types';
import type { ApiBiddingBidBook, ApiBiddingBidBookRow, ApiBiddingJob } from '$lib/api-types';
import {
	resolveBiddingAutomationPanelDraftIdentityKey,
	resolveBiddingAutomationPanelTargetLookupRequestKey,
	resolveInitialBiddingAutomationDeltaEth,
	shouldPreserveBiddingAutomationPanelDraftOnLoadChange
} from '$lib/bidding-automation-panel-state';
import { buildBiddingAutomationDraftFromBid } from '$lib/bidding-automation';

const TARGET_LOOKUP_KEY = 'ethereum:milady:trait:Biome=42';

describe('bidding automation panel state', () => {
	it('refreshes declaration lookups while inactive market state stays fixed', () => {
		const bidBook = testBidBook('2026-01-01T00:00:00Z', 2);
		const before = resolveBiddingAutomationPanelTargetLookupRequestKey({
			targetLookupKey: TARGET_LOOKUP_KEY,
			bidBook,
			jobsChangeSignal: 0
		});
		const after = resolveBiddingAutomationPanelTargetLookupRequestKey({
			targetLookupKey: TARGET_LOOKUP_KEY,
			bidBook,
			jobsChangeSignal: 1
		});
		expect(after).not.toBe(before);
	});

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

	it('preserves editable draft fields during background refreshes after user input', () => {
		expect(
			shouldPreserveBiddingAutomationPanelDraftOnLoadChange({
				draftInputTouched: true,
				saving: false,
				archiving: false
			})
		).toBe(true);
	});

	it('preserves editable draft fields while a mutation is in flight', () => {
		expect(
			shouldPreserveBiddingAutomationPanelDraftOnLoadChange({
				draftInputTouched: false,
				saving: true,
				archiving: false
			})
		).toBe(true);
		expect(
			shouldPreserveBiddingAutomationPanelDraftOnLoadChange({
				draftInputTouched: false,
				saving: false,
				archiving: true
			})
		).toBe(true);
	});

	it('allows the form to reload when no edit or mutation is in progress', () => {
		expect(
			shouldPreserveBiddingAutomationPanelDraftOnLoadChange({
				draftInputTouched: false,
				saving: false,
				archiving: false
			})
		).toBe(false);
	});

	it('distinguishes selected bid draft identities so target changes can reload the form', () => {
		const firstDraft = buildBiddingAutomationDraftFromBid(testTraitBid('0xtrait-a', 'Biome', '42'));
		const secondDraft = buildBiddingAutomationDraftFromBid(
			testTraitBid('0xtrait-b', 'Mode', 'Terrain')
		);

		expect(resolveBiddingAutomationPanelDraftIdentityKey(firstDraft)).not.toBe(
			resolveBiddingAutomationPanelDraftIdentityKey(secondDraft)
		);
	});

	it('uses a compatible collection default for a newly selected bid', () => {
		const draft = buildBiddingAutomationDraftFromBid(testTraitBid('0xtrait-a', 'Biome', '42'));
		expect(
			resolveInitialBiddingAutomationDeltaEth({ job: null, draft, defaultDeltaEth: '0.004' })
		).toBe('0.004');
		expect(
			resolveInitialBiddingAutomationDeltaEth({ job: null, draft, defaultDeltaEth: '0.0004' })
		).toBe('0.001');
	});

	it('ignores incompatible defaults when a selected bid reaches whole ETH prices', () => {
		const bid = testTraitBid('0xwhole-eth', 'Biome', '42');
		bid.price = {
			kind: TRADING_BIDDING_BID_BOOK_PRICE_KIND.Exact,
			wei: '1300000000000000000',
			eth: '1.3'
		};
		const draft = buildBiddingAutomationDraftFromBid(bid);
		expect(
			resolveInitialBiddingAutomationDeltaEth({ job: null, draft, defaultDeltaEth: '0.004' })
		).toBe('0.01');
		expect(
			resolveInitialBiddingAutomationDeltaEth({ job: null, draft, defaultDeltaEth: '0.02' })
		).toBe('0.02');
	});

	it('preserves an existing job delta for validation rather than overwriting it with a default', () => {
		const job: ApiBiddingJob = {
			jobId: 'job-existing',
			status: TRADING_JOB_STATUS.Enabled,
			revision: 1,
			createdAt: '2026-01-01T00:00:00Z',
			updatedAt: '2026-01-01T00:00:00Z',
			archivedAt: null,
			target: { type: TRADING_JOB_TARGET_KIND.Token, tokenId: '42' },
			config: { floorEth: '1.3', ceilingEth: '1.4', deltaEth: '0.004', pricingSource: null },
			runtime: null
		};
		expect(
			resolveInitialBiddingAutomationDeltaEth({ job, draft: null, defaultDeltaEth: '0.02' })
		).toBe('0.004');
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
		biddingBotStatus: TRADING_BOT_LIFECYCLE_STATUS.Inactive,
		biddingAuthorization: null,
		ownMakerAddress: null,
		bids: []
	};
}

function testTraitBid(orderId: string, key: string, value: string): ApiBiddingBidBookRow {
	return {
		orderId,
		source: TRADING_BIDDING_BID_BOOK_SOURCE.Orders,
		materialization: {
			kind: TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.MarketBid,
			jobId: null,
			status: null,
			phase: null
		},
		scope: {
			kind: TRADING_BIDDING_BID_SCOPE_KIND.Trait,
			label: `${key}=${value}`,
			tokenId: null,
			traits: [{ type: key, value }]
		},
		maker: {
			address: '0x1111111111111111111111111111111111111111',
			label: '0x1111111111111111111111111111111111111111',
			isOwn: false
		},
		price: {
			kind: TRADING_BIDDING_BID_BOOK_PRICE_KIND.Exact,
			wei: '100000000000000000',
			eth: '0.1'
		},
		bidLimits: null,
		quantity: '1',
		currencyAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
		currencySymbol: 'WETH',
		protocolAddress: null,
		validUntil: 1_900_000_000,
		placedAt: '2026-01-02T00:00:00Z',
		snapshotRefreshedAtMs: null,
		seenAt: '2026-01-02T00:00:00Z',
		ownStatus: null
	};
}
