export const SYNC_BACKFILL_LIVE_INVALIDATION_KEY = 'artgod:sync-backfill-state';

export const SYNC_BACKFILL_LIVE_POLL_INTERVAL_MS = 5_000;

export type SyncBackfillLiveRefreshHandle = {
	refreshNow(): Promise<void>;
	stop(): void;
};

type SyncBackfillLiveRefreshOptions = {
	invalidate: (resource: string) => Promise<unknown> | unknown;
	intervalMs?: number;
	resource?: string;
};

// Poll the route load key without overlapping backend refreshes.
export function startSyncBackfillLiveRefresh({
	invalidate,
	intervalMs = SYNC_BACKFILL_LIVE_POLL_INTERVAL_MS,
	resource = SYNC_BACKFILL_LIVE_INVALIDATION_KEY
}: SyncBackfillLiveRefreshOptions): SyncBackfillLiveRefreshHandle {
	let stopped = false;
	let refreshInFlight = false;

	const refreshNow = async (): Promise<void> => {
		if (stopped || refreshInFlight) return;
		refreshInFlight = true;
		try {
			await invalidate(resource);
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
