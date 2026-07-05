import { formatRfc3339 } from '$lib/compact-time-display';

// Drives compact countdown labels for live-refresh metadata rows.
export const LIVE_REFRESH_RELATIVE_TIME_TICK_MS = 1_000;

export type ScheduledLiveRefreshHandle = {
	refreshNow(): Promise<void>;
	stop(): void;
};

type ScheduledLiveRefreshOptions = {
	refresh: () => Promise<unknown> | unknown;
	intervalMs: () => number;
	onNextUpdate?: (nextUpdateAtMs: number | null) => void;
};

// Poll a visible view on a scheduled cadence without overlapping backend refreshes.
export function startScheduledLiveRefresh({
	refresh,
	intervalMs,
	onNextUpdate
}: ScheduledLiveRefreshOptions): ScheduledLiveRefreshHandle {
	let stopped = false;
	let refreshInFlight = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const scheduleNext = (): void => {
		if (stopped) return;
		const delayMs = intervalMs();
		onNextUpdate?.(Date.now() + delayMs);
		timer = setTimeout(() => {
			void runScheduledRefresh();
		}, delayMs);
	};

	const refreshNow = async (): Promise<void> => {
		if (stopped || refreshInFlight) return;
		refreshInFlight = true;
		try {
			await refresh();
		} catch {
			// Keep polling after transient backend or network failures.
		} finally {
			refreshInFlight = false;
		}
	};

	const runScheduledRefresh = async (): Promise<void> => {
		await refreshNow();
		scheduleNext();
	};

	scheduleNext();

	return {
		refreshNow,
		stop() {
			stopped = true;
			onNextUpdate?.(null);
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
		}
	};
}

// Formats a scheduled live-refresh countdown for compact UI metadata rows.
export function formatLiveRefreshNextUpdate(nextUpdateAtMs: number | null, nowMs: number): string {
	if (nextUpdateAtMs === null) {
		return '-';
	}
	const secondsUntilUpdate = Math.max(0, Math.ceil((nextUpdateAtMs - nowMs) / 1000));
	if (secondsUntilUpdate < 60) {
		return `${secondsUntilUpdate}s`;
	}
	if (secondsUntilUpdate < 3600) {
		return `${Math.ceil(secondsUntilUpdate / 60)}m`;
	}
	if (secondsUntilUpdate < 86_400) {
		return `${Math.ceil(secondsUntilUpdate / 3600)}h`;
	}
	return `${Math.ceil(secondsUntilUpdate / 86_400)}d`;
}

// Formats a scheduled live-refresh timestamp as UTC for native title tooltips.
export function liveRefreshNextUpdateTitle(nextUpdateAtMs: number | null): string | undefined {
	return nextUpdateAtMs === null ? undefined : formatRfc3339(nextUpdateAtMs);
}
