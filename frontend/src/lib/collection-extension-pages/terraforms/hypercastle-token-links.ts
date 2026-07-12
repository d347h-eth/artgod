import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import {
	TERRAFORMS_BIOME_ATTRIBUTE_KEY,
	TERRAFORMS_LEVEL_ATTRIBUTE_KEY,
	TERRAFORMS_ZONE_ATTRIBUTE_KEY
} from '@artgod/shared/extensions/terraforms';
import { TOKEN_BROWSER_STATUS } from '@artgod/shared/types/browse';
import type { ApiTokenAttribute } from '$lib/api-types';
import { buildTokenBrowserHref, TOKEN_BROWSER_DISPLAY_MODES } from '$lib/token-browser-query';

const TERRAFORMS_HYPERCASTLE_TOKEN_FILTER_LABEL_PREFIX = 'filter tokens by';
const TERRAFORMS_HYPERCASTLE_TOKEN_FILTER_LABEL_SEPARATOR = ', ';
const TERRAFORMS_HYPERCASTLE_TOKEN_FILTER_LABEL_VALUE_SEPARATOR = ' ';

// Builds ordered Hypercastle traits so downstream links preserve the user's drilldown context.
export function buildTerraformsHypercastleTokenFilterTraits(input: {
	levelNumber?: number | null;
	zoneName?: string | null;
	biomeIndex?: number | null;
}): ApiTokenAttribute[] {
	const traits: ApiTokenAttribute[] = [];
	if (input.levelNumber !== null && input.levelNumber !== undefined) {
		traits.push({ key: TERRAFORMS_LEVEL_ATTRIBUTE_KEY, value: String(input.levelNumber) });
	}
	if (input.zoneName !== null && input.zoneName !== undefined) {
		traits.push({ key: TERRAFORMS_ZONE_ATTRIBUTE_KEY, value: input.zoneName });
	}
	if (input.biomeIndex !== null && input.biomeIndex !== undefined) {
		traits.push({ key: TERRAFORMS_BIOME_ATTRIBUTE_KEY, value: String(input.biomeIndex) });
	}
	return traits;
}

// Describes the complete trait filter that a Hypercastle token link will open.
export function formatTerraformsHypercastleTokenFilterLabel(
	traits: readonly ApiTokenAttribute[]
): string {
	return [
		TERRAFORMS_HYPERCASTLE_TOKEN_FILTER_LABEL_PREFIX,
		traits
			.map((trait) =>
				[trait.key, trait.value].join(TERRAFORMS_HYPERCASTLE_TOKEN_FILTER_LABEL_VALUE_SEPARATOR)
			)
			.join(TERRAFORMS_HYPERCASTLE_TOKEN_FILTER_LABEL_SEPARATOR)
	].join(TERRAFORMS_HYPERCASTLE_TOKEN_FILTER_LABEL_VALUE_SEPARATOR);
}

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
