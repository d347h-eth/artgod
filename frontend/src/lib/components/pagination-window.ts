export type PaginationWindowState<TItem> = {
	items: TItem[];
	rangeStart: number;
	rangeEnd: number;
	pagesLoaded: number;
	headPrevCursor: string | null;
	tailNextCursor: string | null;
};

export type PaginationWindowMetrics = {
	remainingItems: number;
	hasPreviousPage: boolean;
	hasNextPage: boolean;
	visibleStartPage: number;
	visibleEndPage: number;
};

type CursorPageLike<TItem> = {
	items: TItem[];
	rangeStart: number;
	rangeEnd: number;
	prevCursor: string | null;
	nextCursor: string | null;
};

const paginationWindowCache = new Map<string, PaginationWindowState<unknown>>();

// Builds a stable cache key for one cursor-paginated result set.
export function buildPaginationWindowSignature(
	parts: Array<string | number | boolean | null | undefined>
): string {
	return parts.map((part) => String(part ?? '')).join('|');
}

// Builds stable signature parts for selected trait filters and numeric ranges.
export function traitFilterPaginationSignatureParts(params: {
	traits: Array<{ key: string; value: string }>;
	ranges: Array<{ key: string; fromValue: string | null; toValue: string | null }>;
}): string[] {
	const normalizedTraits = params.traits
		.map((item) => `${item.key}:${item.value}`)
		.sort((a, b) => a.localeCompare(b));
	const normalizedRanges = params.ranges
		.map((item) => `${item.key}:${item.fromValue ?? ''}..${item.toValue ?? ''}`)
		.sort((a, b) => a.localeCompare(b));
	return [normalizedTraits.join(','), normalizedRanges.join(',')];
}

// Reads the currently accumulated page window for a stable result-set signature.
export function readPaginationWindow<TItem>(
	signature: string
): PaginationWindowState<TItem> | null {
	return (paginationWindowCache.get(signature) as PaginationWindowState<TItem> | undefined) ?? null;
}

// Stores the accumulated page window so navigation can append or prepend cursor results.
export function writePaginationWindow<TItem>(
	signature: string,
	state: PaginationWindowState<TItem>
): void {
	paginationWindowCache.set(signature, state as PaginationWindowState<unknown>);
}

// Converts a single cursor page response into the shared accumulated window shape.
export function pageToPaginationWindow<TItem>(
	page: CursorPageLike<TItem>
): PaginationWindowState<TItem> {
	return {
		items: page.items,
		rangeStart: page.rangeStart,
		rangeEnd: page.rangeEnd,
		pagesLoaded: page.items.length === 0 ? 0 : 1,
		headPrevCursor: page.prevCursor,
		tailNextCursor: page.nextCursor
	};
}

// Resolves display metrics for the currently accumulated page window.
export function describePaginationWindow(params: {
	totalItems: number;
	rangeStart: number;
	rangeEnd: number;
	limit: number;
	tailNextCursor: string | null;
}): PaginationWindowMetrics {
	return {
		remainingItems: Math.max(params.totalItems - params.rangeEnd, 0),
		hasPreviousPage: params.rangeStart > 1,
		hasNextPage: params.tailNextCursor !== null,
		visibleStartPage:
			params.rangeStart === 0 ? 0 : Math.floor((params.rangeStart - 1) / params.limit) + 1,
		visibleEndPage:
			params.rangeEnd === 0 ? 0 : Math.floor((params.rangeEnd - 1) / params.limit) + 1
	};
}

// Merges a newly loaded cursor page into the cached window when the cursor is adjacent.
export function resolvePaginationWindow<TItem>(params: {
	cached: PaginationWindowState<TItem> | null;
	incoming: PaginationWindowState<TItem>;
	requestCursor: string | null;
	itemKey: (item: TItem) => string;
}): PaginationWindowState<TItem> {
	const { cached, incoming, requestCursor, itemKey } = params;
	if (!cached) return incoming;

	const isAppend =
		requestCursor !== null &&
		cached.tailNextCursor !== null &&
		requestCursor === cached.tailNextCursor;

	const isPrependByCursor =
		requestCursor !== null &&
		cached.headPrevCursor !== null &&
		requestCursor === cached.headPrevCursor;

	const isPrependFirstPage =
		requestCursor === null &&
		cached.rangeStart > 1 &&
		incoming.rangeStart === 1 &&
		incoming.rangeEnd > 0 &&
		incoming.rangeEnd < cached.rangeStart;

	if (isAppend) {
		return {
			items: appendUniqueItems(cached.items, incoming.items, itemKey),
			rangeStart: cached.rangeStart || incoming.rangeStart,
			rangeEnd: Math.max(cached.rangeEnd, incoming.rangeEnd),
			pagesLoaded: cached.pagesLoaded + (incoming.items.length === 0 ? 0 : 1),
			headPrevCursor: cached.headPrevCursor ?? incoming.headPrevCursor,
			tailNextCursor: incoming.tailNextCursor
		};
	}

	if (isPrependByCursor || isPrependFirstPage) {
		return {
			items: prependUniqueItems(cached.items, incoming.items, itemKey),
			rangeStart:
				cached.rangeStart === 0
					? incoming.rangeStart
					: incoming.rangeStart > 0
						? Math.min(cached.rangeStart, incoming.rangeStart)
						: cached.rangeStart,
			rangeEnd: Math.max(cached.rangeEnd, incoming.rangeEnd),
			pagesLoaded: cached.pagesLoaded + (incoming.items.length === 0 ? 0 : 1),
			headPrevCursor: incoming.headPrevCursor,
			tailNextCursor: cached.tailNextCursor
		};
	}

	return incoming;
}

// Replaces the refreshed page slice inside an accumulated window without collapsing loaded pages.
export function refreshPaginationWindow<TItem>(params: {
	cached: PaginationWindowState<TItem> | null;
	incoming: PaginationWindowState<TItem>;
	itemKey: (item: TItem) => string;
}): PaginationWindowState<TItem> {
	const { cached, incoming, itemKey } = params;
	if (!cached) return incoming;
	if (incoming.items.length === 0) return incoming;
	if (incoming.rangeStart === 0 || incoming.rangeEnd === 0) return incoming;
	if (cached.rangeStart === 0 || cached.rangeEnd === 0) return incoming;

	const incomingBeforeCached = incoming.rangeEnd < cached.rangeStart;
	const incomingAfterCached = incoming.rangeStart > cached.rangeEnd;
	if (incomingBeforeCached || incomingAfterCached) return cached;

	const replaceStart = Math.max(incoming.rangeStart - cached.rangeStart, 0);
	const replaceEnd = Math.min(incoming.rangeEnd - cached.rangeStart + 1, cached.items.length);
	const nextItems = dedupeItems(
		[
			...cached.items.slice(0, replaceStart),
			...incoming.items,
			...cached.items.slice(replaceEnd)
		],
		itemKey
	);

	return {
		items: nextItems,
		rangeStart: Math.min(cached.rangeStart, incoming.rangeStart),
		rangeEnd: Math.max(cached.rangeEnd, incoming.rangeEnd),
		pagesLoaded: cached.pagesLoaded,
		headPrevCursor:
			incoming.rangeStart <= cached.rangeStart ? incoming.headPrevCursor : cached.headPrevCursor,
		tailNextCursor:
			incoming.rangeEnd >= cached.rangeEnd ? incoming.tailNextCursor : cached.tailNextCursor
	};
}

function appendUniqueItems<TItem>(
	source: TItem[],
	incoming: TItem[],
	itemKey: (item: TItem) => string
): TItem[] {
	if (incoming.length === 0) return source;
	const seen = new Set(source.map(itemKey));
	const merged = [...source];
	for (const item of incoming) {
		const key = itemKey(item);
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(item);
	}
	return merged;
}

function dedupeItems<TItem>(items: TItem[], itemKey: (item: TItem) => string): TItem[] {
	const seen = new Set<string>();
	const deduped: TItem[] = [];
	for (const item of items) {
		const key = itemKey(item);
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(item);
	}
	return deduped;
}

function prependUniqueItems<TItem>(
	source: TItem[],
	incoming: TItem[],
	itemKey: (item: TItem) => string
): TItem[] {
	if (incoming.length === 0) return source;
	const seen = new Set<string>();
	const merged: TItem[] = [];
	for (const item of [...incoming, ...source]) {
		const key = itemKey(item);
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(item);
	}
	return merged;
}
