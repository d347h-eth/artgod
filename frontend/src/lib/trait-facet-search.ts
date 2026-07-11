import { TRAIT_FILTER_DISPLAY_KIND } from '@artgod/shared/types';
import type { ApiTraitFacet } from '$lib/api-types';

type TraitFacetValue = ApiTraitFacet['values'][number];

// Minimum normalized input length before root search filters trait buckets.
export const TRAIT_FACET_ROOT_SEARCH_MIN_LENGTH = 2;

// Minimum normalized input length before a bucket search filters its trait values.
export const TRAIT_FACET_BUCKET_SEARCH_MIN_LENGTH = 1;

// Resolves whether a facet participates in text search over discrete values.
export function isTraitFacetValueSearchable(facet: Pick<ApiTraitFacet, 'displayKind'>): boolean {
	return facet.displayKind === TRAIT_FILTER_DISPLAY_KIND.Set;
}

// Normalizes user-entered trait value search before matching.
export function normalizeTraitValueSearch(value: string): string {
	return value.trim().toLowerCase();
}

// Checks whether the user has entered enough text to filter trait buckets from the root search.
export function hasRootTraitValueSearch(value: string): boolean {
	return hasTraitValueSearch(value, TRAIT_FACET_ROOT_SEARCH_MIN_LENGTH);
}

// Checks whether the user has entered enough text to filter values within one trait bucket.
export function hasBucketTraitValueSearch(value: string): boolean {
	return hasTraitValueSearch(value, TRAIT_FACET_BUCKET_SEARCH_MIN_LENGTH);
}

function hasTraitValueSearch(value: string, minimumLength: number): boolean {
	return normalizeTraitValueSearch(value).length >= minimumLength;
}

function traitValueMatchesSearch(value: string, search: string, minimumLength: number): boolean {
	const pattern = normalizeTraitValueSearch(search);
	if (!hasTraitValueSearch(pattern, minimumLength)) return true;

	const haystack = value.toLowerCase();
	if (!pattern.includes('*')) {
		return haystack.includes(pattern);
	}

	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
	return new RegExp(`^${escaped}$`).test(haystack);
}

// Filters one searchable facet's values by its bucket-local search.
export function filterTraitFacetValuesByBucketSearch(
	facet: ApiTraitFacet,
	search: string
): TraitFacetValue[] {
	return filterTraitFacetValues(facet, search, TRAIT_FACET_BUCKET_SEARCH_MIN_LENGTH);
}

// Filters one searchable facet's values by the panel root search.
export function filterTraitFacetValuesByRootSearch(
	facet: ApiTraitFacet,
	search: string
): TraitFacetValue[] {
	return filterTraitFacetValues(facet, search, TRAIT_FACET_ROOT_SEARCH_MIN_LENGTH);
}

function filterTraitFacetValues(
	facet: ApiTraitFacet,
	search: string,
	minimumLength: number
): TraitFacetValue[] {
	if (!isTraitFacetValueSearchable(facet)) return [];
	return facet.values.filter((item) => traitValueMatchesSearch(item.value, search, minimumLength));
}

// Filters the facet list for root-level value search while excluding range facets.
export function filterTraitFacetsByRootSearch(
	facets: ApiTraitFacet[],
	search: string
): ApiTraitFacet[] {
	if (!hasRootTraitValueSearch(search)) return facets;
	return facets.filter((facet) => filterTraitFacetValuesByRootSearch(facet, search).length > 0);
}
