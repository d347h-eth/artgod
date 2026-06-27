import { TRAIT_FILTER_DISPLAY_KIND } from '@artgod/shared/types';
import type { ApiTraitFacet } from '$lib/api-types';

type TraitFacetValue = ApiTraitFacet['values'][number];

// Resolves whether a facet participates in text search over discrete values.
export function isTraitFacetValueSearchable(facet: Pick<ApiTraitFacet, 'displayKind'>): boolean {
	return facet.displayKind === TRAIT_FILTER_DISPLAY_KIND.Set;
}

// Normalizes user-entered trait value search before matching.
export function normalizeTraitValueSearch(value: string): string {
	return value.trim().toLowerCase();
}

// Checks whether the user has entered a meaningful trait value search.
export function hasTraitValueSearch(value: string): boolean {
	return normalizeTraitValueSearch(value).length > 0;
}

// Matches trait values with the same substring and wildcard semantics everywhere.
export function traitValueMatchesSearch(value: string, search: string): boolean {
	const pattern = normalizeTraitValueSearch(search);
	if (!pattern) return true;

	const haystack = value.toLowerCase();
	if (!pattern.includes('*')) {
		return haystack.includes(pattern);
	}

	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
	return new RegExp(`^${escaped}$`).test(haystack);
}

// Filters one searchable facet's values by the user-entered text search.
export function filterTraitFacetValuesBySearch(
	facet: ApiTraitFacet,
	search: string
): TraitFacetValue[] {
	if (!isTraitFacetValueSearchable(facet)) return [];
	return facet.values.filter((item) => traitValueMatchesSearch(item.value, search));
}

// Filters the facet list for root-level value search while excluding range facets.
export function filterTraitFacetsBySearch(
	facets: ApiTraitFacet[],
	search: string
): ApiTraitFacet[] {
	if (!hasTraitValueSearch(search)) return facets;
	return facets.filter((facet) => filterTraitFacetValuesBySearch(facet, search).length > 0);
}
