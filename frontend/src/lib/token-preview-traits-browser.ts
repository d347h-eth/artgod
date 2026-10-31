import { browser } from '$app/env';
import {
	DEFAULT_TOKEN_PREVIEW_TRAIT_DISPLAY,
	TOKEN_PREVIEW_TRAITS_MODE,
	type TokenPreviewTraitDisplay
} from '$lib/token-preview-traits';
import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import { TOKEN_BROWSER_STATUS } from '@artgod/shared/types/browse';
import type { ApiTokenAttribute } from '$lib/api-types';
import { buildCollectionBasePath } from '$lib/collection-navigation';
import { LOCAL_STORAGE_KEYS } from '$lib/local-storage-keys';
import type { CollectionMediaPreferenceInput } from '$lib/media-mode';
import {
	IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
	publicCollectionTokensPath
} from '$lib/runtime/public-deployment';
import { buildTokenBrowserHref, TOKEN_BROWSER_DISPLAY_MODES } from '$lib/token-browser-query';
import { canRepresentTraitFilters } from '$lib/trait-filters';

export function readTokenPreviewTraitDisplay(
	fallback: TokenPreviewTraitDisplay = DEFAULT_TOKEN_PREVIEW_TRAIT_DISPLAY
): TokenPreviewTraitDisplay {
	if (!browser) return fallback;
	try {
		const raw = window.localStorage.getItem(LOCAL_STORAGE_KEYS.tokenPreviewTraitDisplay);
		if (!raw) return fallback;
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object' || !('mode' in parsed))
			return DEFAULT_TOKEN_PREVIEW_TRAIT_DISPLAY;
		if (parsed.mode === TOKEN_PREVIEW_TRAITS_MODE.Summary)
			return DEFAULT_TOKEN_PREVIEW_TRAIT_DISPLAY;
		if (parsed.mode === TOKEN_PREVIEW_TRAITS_MODE.Hidden) return { mode: parsed.mode };
		if (
			parsed.mode === TOKEN_PREVIEW_TRAITS_MODE.Page &&
			'page' in parsed &&
			typeof parsed.page === 'number' &&
			Number.isSafeInteger(parsed.page) &&
			parsed.page >= 0
		) {
			return { mode: parsed.mode, page: parsed.page };
		}
		return DEFAULT_TOKEN_PREVIEW_TRAIT_DISPLAY;
	} catch {
		return fallback;
	}
}

export function persistTokenPreviewTraitDisplay(display: TokenPreviewTraitDisplay): void {
	if (!browser) return;
	try {
		window.localStorage.setItem(
			LOCAL_STORAGE_KEYS.tokenPreviewTraitDisplay,
			JSON.stringify(display)
		);
	} catch {
		// Storage may be disabled; the controller still retains the chosen display.
	}
}

// Like detail-page trait links, inspect matching collection tokens with the full value.
export function buildTokenPreviewTraitHref(params: {
	chainRef: string;
	collectionRef: string;
	trait: ApiTokenAttribute;
	mediaMode: string;
	mediaPreference: CollectionMediaPreferenceInput;
}): string | null {
	if (!canRepresentTraitFilters([params.trait], [])) return null;
	return buildTokenBrowserHref({
		basePath: IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT
			? publicCollectionTokensPath()
			: buildCollectionBasePath(params),
		limit: DEFAULT_PAGE_LIMIT,
		displayMode: TOKEN_BROWSER_DISPLAY_MODES.Grid,
		tokenStatus: TOKEN_BROWSER_STATUS.All,
		selectedTraits: [params.trait],
		selectedTraitRanges: [],
		mediaMode: params.mediaMode,
		mediaPreference: params.mediaPreference
	});
}
