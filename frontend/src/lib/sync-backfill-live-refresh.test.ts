import { afterEach, describe, expect, it, vi } from 'vitest';
import { startSyncBackfillLiveRefresh } from './sync-backfill-live-refresh';

describe('sync backfill live refresh', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('refreshes sync backfill state on each interval', async () => {
		vi.useFakeTimers();
		const refreshState = vi.fn().mockResolvedValue(undefined);
		const refresh = startSyncBackfillLiveRefresh({ refresh: refreshState, intervalMs: 100 });

		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(100);

		expect(refreshState).toHaveBeenCalledTimes(2);
		refresh.stop();
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
		const refresh = startSyncBackfillLiveRefresh({ refresh: refreshState, intervalMs: 100 });

		await vi.advanceTimersByTimeAsync(300);
		expect(refreshState).toHaveBeenCalledTimes(1);

		resolveRefresh();
		await vi.advanceTimersByTimeAsync(100);
		expect(refreshState).toHaveBeenCalledTimes(2);
		refresh.stop();
	});

	it('stops interval refresh', async () => {
		vi.useFakeTimers();
		const refreshState = vi.fn().mockResolvedValue(undefined);
		const refresh = startSyncBackfillLiveRefresh({ refresh: refreshState, intervalMs: 100 });

		refresh.stop();
		await vi.advanceTimersByTimeAsync(300);

		expect(refreshState).not.toHaveBeenCalled();
	});
});
