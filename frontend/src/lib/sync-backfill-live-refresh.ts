export const SYNC_BACKFILL_LIVE_POLL_INTERVAL_MS = 5_000;

export type SyncBackfillLiveRefreshHandle = {
	refreshNow(): Promise<void>;
	stop(): void;
};

type SyncBackfillLiveRefreshOptions = {
	refresh: () => Promise<unknown> | unknown;
	intervalMs?: number;
};

// Poll the visible sync/backfill state without overlapping backend refreshes.
export function startSyncBackfillLiveRefresh({
	refresh,
	intervalMs = SYNC_BACKFILL_LIVE_POLL_INTERVAL_MS
}: SyncBackfillLiveRefreshOptions): SyncBackfillLiveRefreshHandle {
	let stopped = false;
	let refreshInFlight = false;

	const refreshNow = async (): Promise<void> => {
		if (stopped || refreshInFlight) return;
		refreshInFlight = true;
		try {
			await refresh();
		} catch {
			// Keep polling after transient backend/RPC failures.
		} finally {
			refreshInFlight = false;
		}
	};
	const timer = setInterval(() => {
		void refreshNow();
	}, intervalMs);

	return {
		refreshNow,
		stop() {
			stopped = true;
			clearInterval(timer);
		}
	};
}
