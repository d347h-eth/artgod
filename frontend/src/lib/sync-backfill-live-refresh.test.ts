import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	SYNC_BACKFILL_LIVE_INVALIDATION_KEY,
	startSyncBackfillLiveRefresh
} from './sync-backfill-live-refresh';

describe('sync backfill live refresh', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('invalidates the sync backfill load key on each interval', async () => {
		vi.useFakeTimers();
		const invalidate = vi.fn().mockResolvedValue(undefined);
		const refresh = startSyncBackfillLiveRefresh({ invalidate, intervalMs: 100 });

		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(100);

		expect(invalidate).toHaveBeenCalledTimes(2);
		expect(invalidate).toHaveBeenCalledWith(SYNC_BACKFILL_LIVE_INVALIDATION_KEY);
		refresh.stop();
	});

	it('does not overlap slow invalidations', async () => {
		vi.useFakeTimers();
		let resolveRefresh = (): void => {};
		const invalidate = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveRefresh = resolve;
				})
		);
		const refresh = startSyncBackfillLiveRefresh({ invalidate, intervalMs: 100 });

		await vi.advanceTimersByTimeAsync(300);
		expect(invalidate).toHaveBeenCalledTimes(1);

		resolveRefresh();
		await vi.advanceTimersByTimeAsync(100);
		expect(invalidate).toHaveBeenCalledTimes(2);
		refresh.stop();
	});

	it('stops interval invalidation', async () => {
		vi.useFakeTimers();
		const invalidate = vi.fn().mockResolvedValue(undefined);
		const refresh = startSyncBackfillLiveRefresh({ invalidate, intervalMs: 100 });

		refresh.stop();
		await vi.advanceTimersByTimeAsync(300);

		expect(invalidate).not.toHaveBeenCalled();
	});
});
