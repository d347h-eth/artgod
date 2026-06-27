import {
	TERRAFORMS_BIOME_ATTRIBUTE_KEY,
	TERRAFORMS_LEVEL_ATTRIBUTE_KEY,
	TERRAFORMS_ZONE_ATTRIBUTE_KEY
} from '@artgod/shared/extensions/terraforms';
import { TRAIT_CATALOG_QUERY_PARAMS } from '@artgod/shared/types';
import type { ApiTraitCatalogFacet } from '$lib/api-types';
import { getCollectionTraitCatalog } from '$lib/backend-api';
import { TERRAFORMS_HYPERCASTLE_SELECTION_SCOPES } from '$lib/collection-extension-pages/terraforms/hypercastle-selection';

export type TerraformsTraitCountIndex = Readonly<Record<string, number>>;

export type TerraformsHypercastleTraitCounts = {
	zoneTokenCounts: TerraformsTraitCountIndex;
	biomeTokenCounts: TerraformsTraitCountIndex;
};

// Empty count indexes preserve nullable UI state before the backend response arrives.
export const TERRAFORMS_HYPERCASTLE_EMPTY_TRAIT_COUNTS: TerraformsHypercastleTraitCounts = {
	zoneTokenCounts: {},
	biomeTokenCounts: {}
};

const TERRAFORMS_TRAIT_CATALOG_SCOPE_SEPARATOR = ':';
const TERRAFORMS_TRAIT_CATALOG_KEY_SEPARATOR = ',';
const TERRAFORMS_TRAIT_CATALOG_REQUEST_KEY_SEPARATOR = '|';

// Fetches exact Zone and Biome supply counts for the current Hypercastle selection.
export async function fetchTerraformsHypercastleTraitCounts(input: {
	fetch: typeof fetch;
	chainRef: string;
	collectionRef: string;
	levelNumber: number | null;
}): Promise<TerraformsHypercastleTraitCounts> {
	const response = await getCollectionTraitCatalog(
		input.fetch,
		input.chainRef,
		input.collectionRef,
		buildTerraformsTraitCatalogQuery(input.levelNumber)
	);
	return {
		zoneTokenCounts: buildTraitCountIndex(
			resolveTraitCatalogFacet(response.traitCatalog.facets, TERRAFORMS_ZONE_ATTRIBUTE_KEY)
		),
		biomeTokenCounts: buildTraitCountIndex(
			resolveTraitCatalogFacet(response.traitCatalog.facets, TERRAFORMS_BIOME_ATTRIBUTE_KEY)
		)
	};
}

// Builds a stable identity for avoiding duplicate catalog fetches.
export function buildTerraformsTraitCatalogRequestKey(input: {
	chainRef: string;
	collectionRef: string;
	levelNumber: number | null;
}): string {
	return [
		input.chainRef,
		input.collectionRef,
		input.levelNumber === null
			? TERRAFORMS_HYPERCASTLE_SELECTION_SCOPES.AllLevels
			: String(input.levelNumber)
	].join(TERRAFORMS_TRAIT_CATALOG_REQUEST_KEY_SEPARATOR);
}

export function resolveTerraformsTraitTokenCount(
	counts: TerraformsTraitCountIndex,
	value: string,
	countsLoaded: boolean
): number | null {
	if (!countsLoaded) return null;
	return counts[value] ?? 0;
}

function buildTerraformsTraitCatalogQuery(levelNumber: number | null): URLSearchParams {
	const query = new URLSearchParams();
	query.set(
		TRAIT_CATALOG_QUERY_PARAMS.Keys,
		[TERRAFORMS_ZONE_ATTRIBUTE_KEY, TERRAFORMS_BIOME_ATTRIBUTE_KEY].join(
			TERRAFORMS_TRAIT_CATALOG_KEY_SEPARATOR
		)
	);
	if (levelNumber !== null) {
		query.set(
			TRAIT_CATALOG_QUERY_PARAMS.ScopeTraits,
			[TERRAFORMS_LEVEL_ATTRIBUTE_KEY, String(levelNumber)].join(
				TERRAFORMS_TRAIT_CATALOG_SCOPE_SEPARATOR
			)
		);
	}
	return query;
}

function resolveTraitCatalogFacet(
	facets: readonly ApiTraitCatalogFacet[],
	key: string
): ApiTraitCatalogFacet | null {
	return facets.find((facet) => facet.key === key) ?? null;
}

function buildTraitCountIndex(facet: ApiTraitCatalogFacet | null): TerraformsTraitCountIndex {
	const entries = facet?.values.map((value) => [value.value, value.tokenCount] as const) ?? [];
	return Object.fromEntries(entries);
}
