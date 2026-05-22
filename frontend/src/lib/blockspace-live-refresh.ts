export const BLOCKSPACE_LIVE_POLL_INTERVAL_MS = 5_000;

export type BlockspaceLiveRefreshHandle = {
	refreshNow(): Promise<void>;
	stop(): void;
};

type BlockspaceLiveRefreshOptions = {
	refresh: () => Promise<unknown> | unknown;
	intervalMs?: number;
};

// Poll the visible blockspace state without overlapping backend refreshes.
export function startBlockspaceLiveRefresh({
	refresh,
	intervalMs = BLOCKSPACE_LIVE_POLL_INTERVAL_MS
}: BlockspaceLiveRefreshOptions): BlockspaceLiveRefreshHandle {
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
