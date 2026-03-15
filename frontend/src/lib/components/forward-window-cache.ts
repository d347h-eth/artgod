export type ForwardWindowState<TItem> = {
	items: TItem[];
	rangeStart: number;
	rangeEnd: number;
	pagesLoaded: number;
	tailNextCursor: string | null;
};

type ForwardCursorPageLike<TItem> = {
	items: TItem[];
	rangeStart: number;
	rangeEnd: number;
	nextCursor: string | null;
};

const forwardWindowCache = new Map<string, unknown>();

export function readForwardWindow<TItem>(signature: string): ForwardWindowState<TItem> | null {
	return (forwardWindowCache.get(signature) as ForwardWindowState<TItem> | undefined) ?? null;
}

export function writeForwardWindow<TItem>(
	signature: string,
	state: ForwardWindowState<TItem>
): void {
	forwardWindowCache.set(signature, state);
}

export function incomingForwardWindowState<TItem>(
	page: ForwardCursorPageLike<TItem>
): ForwardWindowState<TItem> {
	return {
		items: page.items,
		rangeStart: page.rangeStart,
		rangeEnd: page.rangeEnd,
		pagesLoaded: page.items.length === 0 ? 0 : 1,
		tailNextCursor: page.nextCursor
	};
}

export function resolveForwardWindowState<TItem>(params: {
	cached: ForwardWindowState<TItem> | null;
	incoming: ForwardWindowState<TItem>;
	requestCursor: string | null;
	getItemKey: (item: TItem) => string;
}): ForwardWindowState<TItem> {
	const { cached, incoming, requestCursor, getItemKey } = params;
	if (!cached) return incoming;

	const isAppend =
		requestCursor !== null &&
		cached.tailNextCursor !== null &&
		requestCursor === cached.tailNextCursor;
	if (!isAppend) {
		return incoming;
	}

	return {
		items: appendUniqueItems(cached.items, incoming.items, getItemKey),
		rangeStart: cached.rangeStart || incoming.rangeStart,
		rangeEnd: Math.max(cached.rangeEnd, incoming.rangeEnd),
		pagesLoaded: cached.pagesLoaded + (incoming.items.length === 0 ? 0 : 1),
		tailNextCursor: incoming.tailNextCursor
	};
}

function appendUniqueItems<TItem>(
	source: TItem[],
	incoming: TItem[],
	getItemKey: (item: TItem) => string
): TItem[] {
	if (incoming.length === 0) return source;
	const seen = new Set(source.map((item) => getItemKey(item)));
	const merged = [...source];
	for (const item of incoming) {
		const key = getItemKey(item);
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(item);
	}
	return merged;
}
