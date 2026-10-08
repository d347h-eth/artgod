import { describe, expect, it } from 'vitest';
import {
	COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER as FILTER,
	TRADING_BIDDING_AUTHORIZATION_STATUS as AUTHORIZATION,
	TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE as PHASE,
	TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND as MATERIALIZATION,
	TRADING_BIDDING_BID_BOOK_OWN_STATE as STATE,
	TRADING_BIDDING_JOB_RUNTIME_BID_POSITION as POSITION,
	TRADING_JOB_STATUS as STATUS
} from '@artgod/shared/types';
import { countBiddingBidBookOwnStates } from '@artgod/shared/trading/bid-book-own-state';
import { ownBidStateFilterTabs, ownBiddingJobStateBadges } from './bidding-bid-book-own-status';
import {
	BIDDING_E2E_SCENARIO,
	BIDDING_E2E_SCENARIO_QUERY_PARAM,
	BIDDING_E2E_UNCONFIRMED_BID,
	buildBiddingE2eTokenDetailData
} from './e2e/bidding-automation-fixtures';

describe('saved order and cancellation states in the job panel', () => {
	it.each(Object.values(AUTHORIZATION).filter((status) => status !== AUTHORIZATION.Included))(
		'keeps a saved order unconfirmed with %s authorization after a spec edit',
		(status) => {
			const data = buildBiddingE2eTokenDetailData(
				BIDDING_E2E_UNCONFIRMED_BID.TokenId,
				new URLSearchParams({
					[BIDDING_E2E_SCENARIO_QUERY_PARAM]: BIDDING_E2E_SCENARIO.UnconfirmedBid
				})
			);
			const bidBook = data.tokenBiddingBidBook!;
			bidBook.biddingAuthorization!.status = status;
			expect(data.tokenBiddingJob?.runtime).toBeNull();
			expect(bidBook.bids[0].materialization.phase).toBe(PHASE.AuthorizationRequired);
			expect(ownBiddingJobStateBadges(data.tokenBiddingJob, bidBook)).toEqual([
				{ kind: PHASE.Unconfirmed, label: 'unconfirmed' }
			]);
			bidBook.bids.reverse();
			expect(ownBiddingJobStateBadges(data.tokenBiddingJob, bidBook)[0].kind).toBe(
				PHASE.Unconfirmed
			);
		}
	);

	it.each([
		{ scenario: BIDDING_E2E_SCENARIO.UnconfirmedBidCanceling, phase: PHASE.Canceling },
		{ scenario: BIDDING_E2E_SCENARIO.UnconfirmedBidCancelFailed, phase: PHASE.CancelFailed },
		{ scenario: BIDDING_E2E_SCENARIO.UnconfirmedBidCancelled, phase: PHASE.Cancelled }
	])(
		'keeps the existing job cancellation phase $phase without authorization',
		({ scenario, phase }) => {
			const data = buildBiddingE2eTokenDetailData(
				BIDDING_E2E_UNCONFIRMED_BID.TokenId,
				new URLSearchParams({ [BIDDING_E2E_SCENARIO_QUERY_PARAM]: scenario })
			);
			// An enabled job must not replace explicit cancellation evidence with an auth message.
			const job = { ...data.tokenBiddingJob!, status: STATUS.Enabled };
			expect(
				ownBiddingJobStateBadges(job, data.tokenBiddingBidBook).map((badge) => badge.kind)
			).toContain(phase);
		}
	);
});

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
			{ key: PHASE.CancelFailed, count: 1 },
			{ key: STATE.Unknown, count: 1 },
			{ key: PHASE.Paused, count: 1 }
		]);
		expect(tabs.find((tab) => tab.active)?.key).toBe(PHASE.Paused);
		// Keep the selected category visible even when it has no matching rows.
		const emptySelection = ownBidStateFilterTabs(counts, POSITION.Winning);
		expect(emptySelection.find((tab) => tab.active)).toMatchObject({
			key: POSITION.Winning,
			count: 0
		});
		expect(emptySelection.filter((tab) => !tab.active).every((tab) => tab.count > 0)).toBe(true);
	});

	it('keeps empty active selected when every own row is paused, hiding it otherwise', () => {
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
		expect(tabs.map(({ key }) => key)).toEqual([FILTER.Active, PHASE.Canceling, PHASE.Paused]);
		expect(tabs.find((tab) => tab.active)).toMatchObject({ key: FILTER.Active, count: 0 });
		expect(ownBidStateFilterTabs(counts, null).map(({ key }) => key)).toEqual([
			PHASE.Canceling,
			PHASE.Paused
		]);
	});

	it('keeps only the selected tab when there are no own rows', () => {
		const counts = countBiddingBidBookOwnStates([]);
		expect(ownBidStateFilterTabs(counts, PHASE.Paused)).toMatchObject([
			{ key: PHASE.Paused, count: 0, active: true }
		]);
		expect(ownBidStateFilterTabs(counts, null)).toEqual([]);
	});
});
