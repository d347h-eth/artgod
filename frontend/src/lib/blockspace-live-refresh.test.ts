import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBlockspaceLiveRefresh } from './blockspace-live-refresh';

describe('blockspace live refresh', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('refreshes blockspace state on each interval', async () => {
		vi.useFakeTimers();
		const refreshState = vi.fn().mockResolvedValue(undefined);
		const refresh = startBlockspaceLiveRefresh({ refresh: refreshState, intervalMs: 100 });

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
		const refresh = startBlockspaceLiveRefresh({ refresh: refreshState, intervalMs: 100 });

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
		const refresh = startBlockspaceLiveRefresh({ refresh: refreshState, intervalMs: 100 });

		refresh.stop();
		await vi.advanceTimersByTimeAsync(300);

		expect(refreshState).not.toHaveBeenCalled();
	});
});
