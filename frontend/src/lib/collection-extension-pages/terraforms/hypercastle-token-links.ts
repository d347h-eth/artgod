import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import { TOKEN_BROWSER_STATUS } from '@artgod/shared/types/browse';
import type { ApiTokenAttribute } from '$lib/api-types';
import { buildTokenBrowserHref, TOKEN_BROWSER_DISPLAY_MODES } from '$lib/token-browser-query';

// Builds a token-browser href for Terraforms metadata trait filters.
export function buildTerraformsHypercastleTraitsTokenHref(input: {
	basePath: string;
	mediaMode?: string | null;
	traits: readonly ApiTokenAttribute[];
}): string {
	return buildTokenBrowserHref({
		basePath: input.basePath,
		limit: DEFAULT_PAGE_LIMIT,
		displayMode: TOKEN_BROWSER_DISPLAY_MODES.Grid,
		tokenStatus: TOKEN_BROWSER_STATUS.All,
		selectedTraits: [...input.traits],
		selectedTraitRanges: [],
		mediaMode: input.mediaMode ?? null
	});
}

// Builds a token-browser href for one Terraforms metadata trait.
export function buildTerraformsHypercastleTraitTokenHref(input: {
	basePath: string;
	mediaMode?: string | null;
	traitKey: string;
	traitValue: string;
}): string {
	return buildTerraformsHypercastleTraitsTokenHref({
		basePath: input.basePath,
		mediaMode: input.mediaMode,
		traits: [{ key: input.traitKey, value: input.traitValue }]
	});
}
