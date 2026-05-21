import type { SyncBackfillStateApiResponse } from '$lib/api-types';
import type { SyncBackfillVisibleLevel } from '$lib/sync-backfill-isometric-levels';

export type SyncBackfillPageStackEntry = {
	pageStartBlock: number;
	bucketSize: number;
};

export type SyncBackfillStackPage = SyncBackfillPageStackEntry | null;

export type SyncBackfillStackFetchPlan = {
	reusedStates: SyncBackfillStateApiResponse[];
	pagesToFetch: SyncBackfillStackPage[];
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
	page: SyncBackfillStackPage
): URLSearchParams {
	const apiParams = new URLSearchParams();
	apiParams.set('collection', collection);
	if (page) {
		apiParams.set('page_start', String(page.pageStartBlock));
		apiParams.set('bucket_size', String(page.bucketSize));
	}
	return apiParams;
}

// Build backend state queries for a sequence of visible stack pages.
export function buildSyncBackfillStackStateApiParams(
	collection: string,
	pages: SyncBackfillStackPage[]
): URLSearchParams[] {
	return pages.map((page) => buildSyncBackfillStateApiParams(collection, page));
}

// Resolve the ordered backend pages for a visible stack, including root.
export function buildSyncBackfillVisibleStackPages(stack: string[]): SyncBackfillStackPage[] {
	return buildSyncBackfillVisibleStackPagesFromEntries(
		stack.map(requireSyncBackfillPageStackEntry)
	);
}

// Resolve the ordered backend pages from parsed stack entries.
export function buildSyncBackfillVisibleStackPagesFromEntries(
	stackPages: SyncBackfillPageStackEntry[]
): SyncBackfillStackPage[] {
	return [null, ...stackPages];
}

// Plan the minimum client fetches needed when moving between stack URLs.
export function buildSyncBackfillStackFetchPlan(
	currentStack: string[],
	nextStack: string[],
	currentLevels: SyncBackfillVisibleLevel[]
): SyncBackfillStackFetchPlan {
	const commonStackEntries = countCommonStackEntries(currentStack, nextStack);
	const nextPages = buildSyncBackfillVisibleStackPages(nextStack);
	const reusableLevelCount = Math.min(
		commonStackEntries + 1,
		currentLevels.length,
		nextPages.length
	);
	return {
		reusedStates: currentLevels.slice(0, reusableLevelCount).map((level) => level.state),
		pagesToFetch: nextPages.slice(reusableLevelCount)
	};
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

// Pick the deepest stable level as a scroll anchor for stack transitions.
export function resolveSyncBackfillStackAnchorLevelKey(
	currentStack: string[],
	nextStack: string[],
	currentLevels: SyncBackfillVisibleLevel[]
): string {
	const commonStackEntries = countCommonStackEntries(currentStack, nextStack);
	const anchorIndex = Math.min(commonStackEntries, currentLevels.length - 1);
	return currentLevels[Math.max(0, anchorIndex)]?.key ?? 'root';
}

function countCommonStackEntries(currentStack: string[], nextStack: string[]): number {
	const max = Math.min(currentStack.length, nextStack.length);
	let count = 0;
	while (count < max && currentStack[count] === nextStack[count]) {
		count += 1;
	}
	return count;
}

function requireSyncBackfillPageStackEntry(entry: string): SyncBackfillPageStackEntry {
	const page = parseSyncBackfillPageStackEntry(entry);
	if (!page) {
		throw new Error('invalid sync level stack');
	}
	return page;
}
