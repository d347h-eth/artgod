import type { ApiTokenCard } from '$lib/api-types';

export type TokenWindowState = {
	items: ApiTokenCard[];
	rangeStart: number;
	rangeEnd: number;
	pagesLoaded: number;
	headPrevCursor: string | null;
	tailNextCursor: string | null;
};

const tokenWindowCache = new Map<string, TokenWindowState>();

export function readTokenWindow(signature: string): TokenWindowState | null {
	return tokenWindowCache.get(signature) ?? null;
}

export function writeTokenWindow(signature: string, state: TokenWindowState): void {
	tokenWindowCache.set(signature, state);
}
