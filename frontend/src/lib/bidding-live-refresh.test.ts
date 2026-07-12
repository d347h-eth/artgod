import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRADING_BIDDING_BID_BOOK_SOURCE } from '@artgod/shared/types';
import { DEFAULT_BIDDING_BID_BOOK_LIVE_REFRESH_CONFIG } from '@artgod/shared/config/bidding';
import {
	biddingBidBookLivePollIntervalMs,
	captureBiddingLiveRefreshAnchor,
	restoreBiddingLiveRefreshAnchor,
	startBiddingBidBookLiveRefresh
} from './bidding-live-refresh';

describe('bidding live refresh', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('uses the faster cadence for bidding-bot snapshots', () => {
		expect(biddingBidBookLivePollIntervalMs(TRADING_BIDDING_BID_BOOK_SOURCE.Orders)).toBe(
			DEFAULT_BIDDING_BID_BOOK_LIVE_REFRESH_CONFIG.normalPollMs
		);
		expect(biddingBidBookLivePollIntervalMs(TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot)).toBe(
			DEFAULT_BIDDING_BID_BOOK_LIVE_REFRESH_CONFIG.competitivePollMs
		);
		expect(
			biddingBidBookLivePollIntervalMs(TRADING_BIDDING_BID_BOOK_SOURCE.Orders, {
				normalPollMs: 11,
				competitivePollMs: 7
			})
		).toBe(11);
		expect(
			biddingBidBookLivePollIntervalMs(TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot, {
				normalPollMs: 11,
				competitivePollMs: 7
			})
		).toBe(7);
	});

	it('refreshes bid books on the configured interval', async () => {
		vi.useFakeTimers();
		const refreshState = vi.fn().mockResolvedValue(undefined);
		const refresh = startBiddingBidBookLiveRefresh({
			refresh: refreshState,
			intervalMs: () => 100
		});

		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(100);

		expect(refreshState).toHaveBeenCalledTimes(2);
		refresh.stop();
	});

	it('publishes the next scheduled refresh timestamp', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		const nextUpdate = vi.fn();
		const refresh = startBiddingBidBookLiveRefresh({
			refresh: vi.fn().mockResolvedValue(undefined),
			intervalMs: () => 100,
			onNextUpdate: nextUpdate
		});

		expect(nextUpdate).toHaveBeenLastCalledWith(Date.parse('2026-01-01T00:00:00.100Z'));

		await vi.advanceTimersByTimeAsync(100);

		expect(nextUpdate).toHaveBeenLastCalledWith(Date.parse('2026-01-01T00:00:00.200Z'));
		refresh.stop();
		expect(nextUpdate).toHaveBeenLastCalledWith(null);
	});

	it('does not overlap slow refreshes', async () => {
		vi.useFakeTimers();
		let resolveRefresh = (): void => {};
		const refreshState = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveRefresh = resolve;
				})
		);
		const refresh = startBiddingBidBookLiveRefresh({
			refresh: refreshState,
			intervalMs: () => 100
		});

		await vi.advanceTimersByTimeAsync(300);
		expect(refreshState).toHaveBeenCalledTimes(1);

		resolveRefresh();
		await vi.advanceTimersByTimeAsync(100);
		expect(refreshState).toHaveBeenCalledTimes(2);
		refresh.stop();
	});

	it('restores a visible bid row anchor after content moves', () => {
		const scrollTo = vi.fn();
		vi.stubGlobal('window', {
			innerHeight: 800,
			scrollX: 0,
			scrollY: 100,
			scrollTo
		});
		const row = {
			dataset: {},
			getBoundingClientRect: vi
				.fn()
				.mockReturnValueOnce(rectAt(120, 24))
				.mockReturnValue(rectAt(145, 24))
		};
		const marker = {
			dataset: { openSeaOrderHash: '0xabc' },
			closest: () => row
		};
		const root = {
			querySelectorAll: () => [marker],
			getBoundingClientRect: vi.fn().mockReturnValue(rectAt(20, 200))
		};

		const snapshot = captureBiddingLiveRefreshAnchor(root as unknown as HTMLElement);
		restoreBiddingLiveRefreshAnchor(root as unknown as HTMLElement, snapshot);

		expect(scrollTo).toHaveBeenCalledWith(0, 125);
	});

	it('restores a bid row anchor after new rows push it below the viewport', () => {
		const scrollTo = vi.fn();
		vi.stubGlobal('window', {
			innerHeight: 800,
			scrollX: 0,
			scrollY: 100,
			scrollTo
		});
		const row = {
			dataset: {},
			getBoundingClientRect: vi
				.fn()
				.mockReturnValueOnce(rectAt(120, 24))
				.mockReturnValue(rectAt(900, 24))
		};
		const marker = {
			dataset: { openSeaOrderHash: '0xabc' },
			closest: () => row
		};
		const root = {
			querySelectorAll: () => [marker],
			getBoundingClientRect: vi.fn().mockReturnValue(rectAt(20, 200))
		};

		const snapshot = captureBiddingLiveRefreshAnchor(root as unknown as HTMLElement);
		restoreBiddingLiveRefreshAnchor(root as unknown as HTMLElement, snapshot);

		expect(scrollTo).toHaveBeenCalledWith(0, 880);
	});

	it('does not restore anchors after the user scrolls during refresh', () => {
		const scrollTo = vi.fn();
		const viewport = {
			innerHeight: 800,
			scrollX: 0,
			scrollY: 100,
			scrollTo
		};
		vi.stubGlobal('window', viewport);
		const row = {
			dataset: {},
			getBoundingClientRect: vi
				.fn()
				.mockReturnValueOnce(rectAt(120, 24))
				.mockReturnValue(rectAt(145, 24))
		};
		const marker = {
			dataset: { openSeaOrderHash: '0xabc' },
			closest: () => row
		};
		const root = {
			querySelectorAll: () => [marker],
			getBoundingClientRect: vi.fn().mockReturnValue(rectAt(20, 200))
		};

		const snapshot = captureBiddingLiveRefreshAnchor(root as unknown as HTMLElement);
		viewport.scrollY = 150;
		restoreBiddingLiveRefreshAnchor(root as unknown as HTMLElement, snapshot);

		expect(scrollTo).not.toHaveBeenCalled();
	});
});

function rectAt(top: number, height: number): DOMRect {
	return {
		x: 0,
		y: top,
		top,
		left: 0,
		right: 100,
		bottom: top + height,
		width: 100,
		height,
		toJSON: () => ({})
	} as DOMRect;
}
