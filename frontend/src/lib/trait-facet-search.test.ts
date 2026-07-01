import { TRAIT_FILTER_DISPLAY_KIND } from '@artgod/shared/types';
import { describe, expect, it } from 'vitest';
import type { ApiTraitFacet } from '$lib/api-types';
import {
	filterTraitFacetsBySearch,
	filterTraitFacetValuesBySearch,
	hasTraitValueSearch,
	TRAIT_VALUE_SEARCH_MIN_LENGTH,
	traitValueMatchesSearch
} from './trait-facet-search';

describe('trait facet search', () => {
	it('requires two normalized characters before search becomes active', () => {
		expect(TRAIT_VALUE_SEARCH_MIN_LENGTH).toBe(2);
		expect(hasTraitValueSearch('a')).toBe(false);
		expect(hasTraitValueSearch(' ab ')).toBe(true);
	});

	it('matches values with normalized substring and wildcard searches', () => {
		expect(traitValueMatchesSearch('Blue Beanie', ' b ')).toBe(true);
		expect(traitValueMatchesSearch('Blue Beanie', ' bea ')).toBe(true);
		expect(traitValueMatchesSearch('Blue Beanie', 'blue*')).toBe(true);
		expect(traitValueMatchesSearch('Blue Beanie', 'green*')).toBe(false);
	});

	it('filters set-like facet values without searching range facets', () => {
		const hat = facet('Hat', TRAIT_FILTER_DISPLAY_KIND.Set, ['Beanie', 'Cap']);
		const level = facet('Level', TRAIT_FILTER_DISPLAY_KIND.Range, ['7']);

	expect(filterTraitFacetValuesBySearch(hat, 'bea')).toEqual([
		{ value: 'Beanie', tokenCount: 1, marketplaceBiddingSupported: true }
	]);
	expect(filterTraitFacetValuesBySearch(hat, 'b')).toEqual([
		{ value: 'Beanie', tokenCount: 1, marketplaceBiddingSupported: true },
		{ value: 'Cap', tokenCount: 2, marketplaceBiddingSupported: true }
	]);
		expect(filterTraitFacetValuesBySearch(level, '7')).toEqual([]);
	});

	it('filters root-level facet buckets to matching set-like traits only', () => {
		const facets = [
			facet('Hat', TRAIT_FILTER_DISPLAY_KIND.Set, ['Beanie', 'Cap']),
			facet('Background', TRAIT_FILTER_DISPLAY_KIND.Set, ['Blue']),
			facet('Level', TRAIT_FILTER_DISPLAY_KIND.Range, ['7'])
		];

		expect(filterTraitFacetsBySearch(facets, 'bl').map((item) => item.key)).toEqual(['Background']);
		expect(filterTraitFacetsBySearch(facets, '').map((item) => item.key)).toEqual([
			'Hat',
			'Background',
			'Level'
		]);
	});

	it('treats whitespace-only root searches as empty', () => {
		expect(hasTraitValueSearch('   ')).toBe(false);
	});
});

function facet(
	key: string,
	displayKind: ApiTraitFacet['displayKind'],
	values: string[]
): ApiTraitFacet {
	return {
		key,
		displayKind,
		minValue: null,
		maxValue: null,
		values: values.map((value, index) => ({
			value,
			tokenCount: index + 1,
			marketplaceBiddingSupported: true
		}))
	};
}
