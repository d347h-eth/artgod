import { get } from 'svelte/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	COLLECTION_STATUS,
	TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND,
	TRADING_BIDDING_BID_BOOK_PRICE_KIND,
	TRADING_BIDDING_BID_BOOK_SOURCE,
	TRADING_BIDDING_BID_SCOPE_KIND
} from '@artgod/shared/types';
import type {
	ApiBiddingBidBook,
	ApiBiddingBidBookRow,
	ApiChain,
	ApiCollection
} from '$lib/api-types';
import {
	BIDDING_AUTOMATION_DRAFT_TARGET_TYPE,
	BIDDING_AUTOMATION_PRICING_MODE,
	BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE,
	type BiddingAutomationDraft
} from '$lib/bidding-automation';
import { logger } from '@artgod/shared/utils/logger';
import { createTokenBiddingPanelBidBookController } from './token-bidding-panel-bid-book-controller';

const TEST_CHAIN: ApiChain = {
	id: 1,
	type: 'evm',
	publicChainId: 1,
	slug: 'ethereum',
	name: 'Ethereum'
};

const TEST_COLLECTION: ApiCollection = {
	chainId: 1,
	collectionId: 1,
	slug: 'milady',
	address: '0x1111111111111111111111111111111111111111',
	standard: 'erc721',
	status: COLLECTION_STATUS.Live,
	deploymentBlock: 1,
	bootstrapAnchorBlock: null,
	createdAt: '2026-01-01T00:00:00Z',
	updatedAt: '2026-01-01T00:00:00Z'
};

describe('createTokenBiddingPanelBidBookController', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('hydrates bid-book state for an exact token panel target', async () => {
		const controller = createTokenBiddingPanelBidBookController();
		vi.spyOn(logger, 'info').mockImplementation(() => {});
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					tokenId: '7',
					bidBook: testBidBook([testBidBookRow('0xown-token-7', '7')])
				})
			)
		);

		await controller.refreshNow({
			fetchFn: globalThis.fetch,
			chain: TEST_CHAIN,
			collection: TEST_COLLECTION,
			draft: tokenDraft(['7']),
			open: true
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(get(controller.state)).toEqual({
			tokenId: '7',
			bidBook: testBidBook([testBidBookRow('0xown-token-7', '7')])
		});
	});

	it('does not hydrate multi-token targets by treating the first token as selected', async () => {
		const controller = createTokenBiddingPanelBidBookController();
		const fetchMock = vi.spyOn(globalThis, 'fetch');

		await controller.refreshNow({
			fetchFn: globalThis.fetch,
			chain: TEST_CHAIN,
			collection: TEST_COLLECTION,
			draft: tokenDraft(['7', '8']),
			open: true
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(get(controller.state).tokenId).toBeNull();
	});

	it('keeps stale token responses from replacing a newer selected target', async () => {
		const controller = createTokenBiddingPanelBidBookController();
		vi.spyOn(logger, 'info').mockImplementation(() => {});
		let resolveFirst = (_response: Response) => {};
		const firstResponse = new Promise<Response>((resolve) => {
			resolveFirst = resolve;
		});
		vi.spyOn(globalThis, 'fetch')
			.mockReturnValueOnce(firstResponse)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						tokenId: '8',
						bidBook: testBidBook([testBidBookRow('0xown-token-8', '8')])
					})
				)
			);

		const firstRefresh = controller.refreshNow({
			fetchFn: globalThis.fetch,
			chain: TEST_CHAIN,
			collection: TEST_COLLECTION,
			draft: tokenDraft(['7']),
			open: true
		});
		await controller.refreshNow({
			fetchFn: globalThis.fetch,
			chain: TEST_CHAIN,
			collection: TEST_COLLECTION,
			draft: tokenDraft(['8']),
			open: true
		});
		resolveFirst(
			new Response(
				JSON.stringify({
					tokenId: '7',
					bidBook: testBidBook([testBidBookRow('0xown-token-7', '7')])
				})
			)
		);
		await firstRefresh;

		expect(get(controller.state)).toEqual({
			tokenId: '8',
			bidBook: testBidBook([testBidBookRow('0xown-token-8', '8')])
		});
	});
});

function tokenDraft(tokenIds: string[]): BiddingAutomationDraft {
	return {
		source: {
			type: BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.ExplicitTokens,
			tokenIds
		},
		target: {
			type: BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TokenBatch,
			tokenIds
		},
		pricing: {
			mode: BIDDING_AUTOMATION_PRICING_MODE.Manual,
			floorEth: '',
			ceilingEth: '',
			deltaEth: ''
		}
	};
}

function testBidBook(bids: ApiBiddingBidBookRow[]): ApiBiddingBidBook {
	return {
		state: {
			source: TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot,
			updatedAt: null,
			snapshotRefreshedAtMs: null,
			projectedAt: null,
			rowCount: bids.length,
			durationMs: null,
			lastError: null
		},
		ownMakerAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		bids
	};
}

function testBidBookRow(orderId: string, tokenId: string): ApiBiddingBidBookRow {
	return {
		orderId,
		source: TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot,
		materialization: {
			kind: TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.MarketBid,
			jobId: null,
			status: null,
			phase: null
		},
		scope: {
			kind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
			label: `#${tokenId}`,
			tokenId,
			traits: []
		},
		maker: {
			address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			label: 'You',
			isOwn: true
		},
		price: {
			kind: TRADING_BIDDING_BID_BOOK_PRICE_KIND.Exact,
			wei: '200000000000000000',
			eth: '0.2'
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
