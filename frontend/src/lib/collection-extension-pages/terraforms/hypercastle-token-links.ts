import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import { TOKEN_BROWSER_STATUS } from '@artgod/shared/types/browse';
import { buildTokenBrowserHref, TOKEN_BROWSER_DISPLAY_MODES } from '$lib/token-browser-query';

// Builds a token-browser href for one Terraforms metadata trait.
export function buildTerraformsHypercastleTraitTokenHref(input: {
	basePath: string;
	mediaMode?: string | null;
	traitKey: string;
	traitValue: string;
}): string {
	return buildTokenBrowserHref({
		basePath: input.basePath,
		limit: DEFAULT_PAGE_LIMIT,
		displayMode: TOKEN_BROWSER_DISPLAY_MODES.Grid,
		tokenStatus: TOKEN_BROWSER_STATUS.All,
		selectedTraits: [{ key: input.traitKey, value: input.traitValue }],
		selectedTraitRanges: [],
		mediaMode: input.mediaMode ?? null
	});
}
