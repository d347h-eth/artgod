import type { BlockspaceStateApiResponse } from '$lib/api-types';
import type { BlockspaceVisibleLevel } from '$lib/blockspace-isometric-levels';

export type BlockspacePageStackEntry = {
	pageStartBlock: number;
	bucketSize: number;
};

export type BlockspaceStackPage = BlockspacePageStackEntry | null;

export type BlockspaceStackFetchPlan = {
	reusedStates: BlockspaceStateApiResponse[];
	pagesToFetch: BlockspaceStackPage[];
};

// Serialize one visible blockspace page into the URL stack query.
export function formatBlockspacePageStackEntry(page: BlockspacePageStackEntry): string {
	return `${page.pageStartBlock}:${page.bucketSize}`;
}

// Parse one URL stack segment without binding the helper to SvelteKit errors.
export function parseBlockspacePageStackEntry(
	entry: string
): BlockspacePageStackEntry | null {
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
export function parseBlockspacePageStack(raw: string | null): BlockspacePageStackEntry[] | null {
	if (!raw?.trim()) return [];
	const stack: BlockspacePageStackEntry[] = [];
	for (const entry of raw
		.split(',')
		.map((value) => value.trim())
		.filter(Boolean)) {
		const parsed = parseBlockspacePageStackEntry(entry);
		if (!parsed) return null;
		stack.push(parsed);
	}
	return stack;
}

// Build the backend state query for one visible blockspace page.
export function buildBlockspaceStateApiParams(
	collection: string,
	page: BlockspaceStackPage
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
export function buildBlockspaceStackStateApiParams(
	collection: string,
	pages: BlockspaceStackPage[]
): URLSearchParams[] {
	return pages.map((page) => buildBlockspaceStateApiParams(collection, page));
}

// Resolve the ordered backend pages for a visible stack, including root.
export function buildBlockspaceVisibleStackPages(stack: string[]): BlockspaceStackPage[] {
	return buildBlockspaceVisibleStackPagesFromEntries(
		stack.map(requireBlockspacePageStackEntry)
	);
}

// Resolve the ordered backend pages from parsed stack entries.
export function buildBlockspaceVisibleStackPagesFromEntries(
	stackPages: BlockspacePageStackEntry[]
): BlockspaceStackPage[] {
	return [null, ...stackPages];
}

// Plan the minimum client fetches needed when moving between stack URLs.
export function buildBlockspaceStackFetchPlan(
	currentStack: string[],
	nextStack: string[],
	currentLevels: BlockspaceVisibleLevel[]
): BlockspaceStackFetchPlan {
	const commonStackEntries = countCommonStackEntries(currentStack, nextStack);
	const nextPages = buildBlockspaceVisibleStackPages(nextStack);
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
export function buildBlockspaceVisibleLevels(
	stack: string[],
	states: BlockspaceStateApiResponse[]
): BlockspaceVisibleLevel[] {
	return states.map((state, index) => ({
		key: index === 0 ? 'root' : `L${index}:${stack[index - 1]}`,
		label: index === 0 ? 'root' : `L${index}`,
		stack: stack.slice(0, index),
		state
	}));
}

// Pick the deepest stable level as a scroll anchor for stack transitions.
export function resolveBlockspaceStackAnchorLevelKey(
	currentStack: string[],
	nextStack: string[],
	currentLevels: BlockspaceVisibleLevel[]
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

function requireBlockspacePageStackEntry(entry: string): BlockspacePageStackEntry {
	const page = parseBlockspacePageStackEntry(entry);
	if (!page) {
		throw new Error('invalid sync level stack');
	}
	return page;
}
