import { describe, expect, it } from 'vitest';
import {
	COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER as FILTER,
	TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE as PHASE,
	TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND as MATERIALIZATION,
	TRADING_BIDDING_BID_BOOK_OWN_STATE as STATE,
	TRADING_BIDDING_JOB_RUNTIME_BID_POSITION as POSITION,
	TRADING_JOB_STATUS as STATUS
} from '@artgod/shared/types';
import { countBiddingBidBookOwnStates } from '@artgod/shared/trading/bid-book-own-state';
import { ownBidStateFilterTabs } from './bidding-bid-book-own-status';

describe('own bid state tabs', () => {
	it('shows every matching category including pause during cancellation and unknown market state', () => {
		const counts = countBiddingBidBookOwnStates([
			{
				isOwn: true,
				ownStatus: null,
				materialization: {
					kind: MATERIALIZATION.OwnJobIntent,
					phase: PHASE.CancelFailed,
					status: STATUS.Paused
				}
			},
			{
				isOwn: true,
				ownStatus: null,
				materialization: { kind: MATERIALIZATION.MarketBid, phase: null, status: null }
			}
		]);
		const tabs = ownBidStateFilterTabs(counts, PHASE.Paused);
		expect(tabs.map(({ key, count }) => ({ key, count }))).toEqual([
			{ key: FILTER.Active, count: 1 },
			{ key: PHASE.Paused, count: 1 },
			{ key: PHASE.CancelFailed, count: 1 },
			{ key: STATE.Unknown, count: 1 }
		]);
		expect(tabs.find((tab) => tab.active)?.key).toBe(PHASE.Paused);
		// A selected empty category disappears without selecting a different tab.
		const emptySelection = ownBidStateFilterTabs(counts, POSITION.Winning);
		expect(emptySelection.every((tab) => tab.count > 0)).toBe(true);
		expect(emptySelection.some((tab) => tab.active)).toBe(false);
	});

	it('hides Active when every own row is paused and preserves an empty Active selection', () => {
		const counts = countBiddingBidBookOwnStates([
			{
				isOwn: true,
				ownStatus: null,
				materialization: {
					kind: MATERIALIZATION.OwnJobIntent,
					phase: PHASE.Canceling,
					status: STATUS.Paused
				}
			}
		]);
		const tabs = ownBidStateFilterTabs(counts, FILTER.Active);
		expect(tabs.map(({ key }) => key)).toEqual([PHASE.Paused, PHASE.Canceling]);
		expect(tabs.some((tab) => tab.active)).toBe(false);
	});

	it('hides every tab including Active when there are no own rows', () => {
		expect(ownBidStateFilterTabs(countBiddingBidBookOwnStates([]), PHASE.Paused)).toEqual([]);
	});
});
