import type { SyncBackfillStateApiResponse } from '$lib/api-types';
import type { SyncBackfillVisibleLevel } from '$lib/sync-backfill-isometric-levels';

export type SyncBackfillPageStackEntry = {
	pageStartBlock: number;
	bucketSize: number;
};

// Serialize one visible sync/backfill page into the URL stack query.
export function formatSyncBackfillPageStackEntry(page: SyncBackfillPageStackEntry): string {
	return `${page.pageStartBlock}:${page.bucketSize}`;
}

// Parse one URL stack segment without binding the helper to SvelteKit errors.
export function parseSyncBackfillPageStackEntry(
	entry: string
): SyncBackfillPageStackEntry | null {
	const [pageStartRaw, bucketSizeRaw, extra] = entry.split(':');
	const pageStartBlock = Number(pageStartRaw);
	const bucketSize = Number(bucketSizeRaw);
	if (
		extra !== undefined ||
		!Number.isInteger(pageStartBlock) ||
		!Number.isInteger(bucketSize) ||
		pageStartBlock < 0 ||
		bucketSize <= 0
	) {
		return null;
	}
	return { pageStartBlock, bucketSize };
}

// Parse the URL stack query into ordered visible child pages.
export function parseSyncBackfillPageStack(raw: string | null): SyncBackfillPageStackEntry[] | null {
	if (!raw?.trim()) return [];
	const stack: SyncBackfillPageStackEntry[] = [];
	for (const entry of raw
		.split(',')
		.map((value) => value.trim())
		.filter(Boolean)) {
		const parsed = parseSyncBackfillPageStackEntry(entry);
		if (!parsed) return null;
		stack.push(parsed);
	}
	return stack;
}

// Build the backend state query for one visible sync/backfill page.
export function buildSyncBackfillStateApiParams(
	collection: string,
	page: SyncBackfillPageStackEntry | null
): URLSearchParams {
	const apiParams = new URLSearchParams();
	apiParams.set('collection', collection);
	if (page) {
		apiParams.set('page_start', String(page.pageStartBlock));
		apiParams.set('bucket_size', String(page.bucketSize));
	}
	return apiParams;
}

// Pair fetched page states with their URL stack entries for rendering.
export function buildSyncBackfillVisibleLevels(
	stack: string[],
	states: SyncBackfillStateApiResponse[]
): SyncBackfillVisibleLevel[] {
	return states.map((state, index) => ({
		key: index === 0 ? 'root' : `L${index}:${stack[index - 1]}`,
		label: index === 0 ? 'root' : `L${index}`,
		stack: stack.slice(0, index),
		state
	}));
}
