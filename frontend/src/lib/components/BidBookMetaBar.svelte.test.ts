import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import {
	TRADING_BIDDING_AUTHORIZATION_STATUS,
	TRADING_BIDDING_BID_BOOK_SOURCE,
	TRADING_BOT_LIFECYCLE_STATUS,
	type TradingBiddingBidBookSource,
	type TradingBotLifecycleStatus
} from '@artgod/shared/types';
import type { ApiBiddingBidBook } from '$lib/api-types';
import BidBookMetaBar from './BidBookMetaBar.svelte';

function bidBook(
	source: TradingBiddingBidBookSource,
	biddingBotStatus: TradingBotLifecycleStatus,
	biddingAuthorization: ApiBiddingBidBook['biddingAuthorization'] = null
): ApiBiddingBidBook {
	return {
		state: {
			source,
			updatedAt: null,
			snapshotRefreshedAtMs: null,
			projectedAt: null,
			rowCount: 0,
			durationMs: null,
			lastError: null
		},
		biddingBotStatus,
		biddingAuthorization,
		ownMakerAddress: null,
		bids: []
	};
}

describe('BidBookMetaBar', () => {
	it.each([
		[TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot, 'bidding bot'],
		[TRADING_BIDDING_BID_BOOK_SOURCE.Orders, 'indexed orders']
	])('renders the %s source as the %s bid-book feed', (source, expectedFeed) => {
		const { body } = render(BidBookMetaBar, {
			props: {
				bidBook: bidBook(source, TRADING_BOT_LIFECYCLE_STATUS.Inactive)
			}
		});

		expect(body).toContain('bid-book feed');
		expect(body).toContain(`>${expectedFeed}</span>`);
		expect(body).not.toContain('refresh pace');
	});

	it.each([
		TRADING_BOT_LIFECYCLE_STATUS.Starting,
		TRADING_BOT_LIFECYCLE_STATUS.Active,
		TRADING_BOT_LIFECYCLE_STATUS.Inactive
	])('renders bidding bot lifecycle status %s independently of the feed', (status) => {
		const { body } = render(BidBookMetaBar, {
			props: {
				bidBook: bidBook(TRADING_BIDDING_BID_BOOK_SOURCE.Orders, status)
			}
		});

		expect(body).toContain('bidding bot');
		expect(body).toContain(`>${status}</span>`);
	});

	it.each([
		[TRADING_BIDDING_AUTHORIZATION_STATUS.Included, 'included'],
		[TRADING_BIDDING_AUTHORIZATION_STATUS.NotIncluded, 'not included'],
		[TRADING_BIDDING_AUTHORIZATION_STATUS.UpdateRequired, 'update required'],
		[TRADING_BIDDING_AUTHORIZATION_STATUS.Inactive, 'inactive'],
		[TRADING_BIDDING_AUTHORIZATION_STATUS.Unavailable, 'unavailable']
	])('renders bidding authorization status %s independently of the feed', (status, label) => {
		const { body } = render(BidBookMetaBar, {
			props: {
				bidBook: bidBook(
					TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot,
					TRADING_BOT_LIFECYCLE_STATUS.Active,
					{
						status,
						maxUnitBidWei: null,
						maxUnitBidEth: null,
						maxQuantity: null
					}
				)
			}
		});

		expect(body).toContain('bidding authorization');
		expect(body).toContain(`>${label}</span>`);
	});
});
