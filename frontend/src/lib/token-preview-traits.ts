import type { ApiTokenAttribute } from '$lib/api-types';

export const TOKEN_PREVIEW_TRAITS_MODE = {
	Summary: 'summary',
	Page: 'page',
	Hidden: 'hidden'
} as const;

export const TOKEN_PREVIEW_TRAITS_LIMITS = {
	RowsPerPage: 20,
	KeyCharacters: 10,
	ValueCharacters: 15
} as const;

export type TokenPreviewTraitDisplay =
	| { mode: typeof TOKEN_PREVIEW_TRAITS_MODE.Summary }
	| { mode: typeof TOKEN_PREVIEW_TRAITS_MODE.Page; page: number }
	| { mode: typeof TOKEN_PREVIEW_TRAITS_MODE.Hidden };

export const DEFAULT_TOKEN_PREVIEW_TRAIT_DISPLAY: TokenPreviewTraitDisplay = {
	mode: TOKEN_PREVIEW_TRAITS_MODE.Summary
};

export function clampTokenPreviewTraitDisplay(
	display: TokenPreviewTraitDisplay,
	traitCount: number
): TokenPreviewTraitDisplay {
	if (display.mode !== TOKEN_PREVIEW_TRAITS_MODE.Page) return display;
	const pageCount = Math.ceil(traitCount / TOKEN_PREVIEW_TRAITS_LIMITS.RowsPerPage);
	if (pageCount === 0) return { mode: TOKEN_PREVIEW_TRAITS_MODE.Hidden };
	const page = Math.min(display.page, pageCount - 1);
	return page === display.page ? display : { mode: TOKEN_PREVIEW_TRAITS_MODE.Page, page };
}

export function nextTokenPreviewTraitDisplay(
	display: TokenPreviewTraitDisplay,
	traitCount: number
): TokenPreviewTraitDisplay {
	const current = clampTokenPreviewTraitDisplay(display, traitCount);
	const pageCount = Math.ceil(traitCount / TOKEN_PREVIEW_TRAITS_LIMITS.RowsPerPage);
	if (current.mode === TOKEN_PREVIEW_TRAITS_MODE.Hidden) return DEFAULT_TOKEN_PREVIEW_TRAIT_DISPLAY;
	if (current.mode === TOKEN_PREVIEW_TRAITS_MODE.Summary && pageCount > 0) {
		return { mode: TOKEN_PREVIEW_TRAITS_MODE.Page, page: 0 };
	}
	if (current.mode === TOKEN_PREVIEW_TRAITS_MODE.Page && current.page + 1 < pageCount) {
		return { mode: TOKEN_PREVIEW_TRAITS_MODE.Page, page: current.page + 1 };
	}
	return { mode: TOKEN_PREVIEW_TRAITS_MODE.Hidden };
}

export function tokenPreviewTraitPage(
	attributes: ApiTokenAttribute[],
	display: TokenPreviewTraitDisplay
): ApiTokenAttribute[] {
	const current = clampTokenPreviewTraitDisplay(display, attributes.length);
	if (current.mode !== TOKEN_PREVIEW_TRAITS_MODE.Page) return [];
	const start = current.page * TOKEN_PREVIEW_TRAITS_LIMITS.RowsPerPage;
	return attributes.slice(start, start + TOKEN_PREVIEW_TRAITS_LIMITS.RowsPerPage);
}

// Cut code points, preserving Unicode and keeping metadata whitespace on one line.
export function clipTokenPreviewTraitText(text: string, limit: number): string {
	let result = '';
	let length = 0;
	for (const character of text) {
		if (length >= limit) break;
		result += /\s/u.test(character) ? ' ' : character;
		length += 1;
	}
	return result;
}
