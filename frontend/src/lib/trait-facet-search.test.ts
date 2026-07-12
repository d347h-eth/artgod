import { TRAIT_FILTER_DISPLAY_KIND } from '@artgod/shared/types';
import { describe, expect, it } from 'vitest';
import type { ApiTraitFacet } from '$lib/api-types';
import {
	filterTraitFacetsByRootSearch,
	filterTraitFacetValuesByBucketSearch,
	hasBucketTraitValueSearch,
	hasRootTraitValueSearch,
	TRAIT_FACET_BUCKET_SEARCH_MIN_LENGTH,
	TRAIT_FACET_ROOT_SEARCH_MIN_LENGTH
} from './trait-facet-search';

describe('trait facet search', () => {
	it('keeps root and bucket search activation thresholds independent', () => {
		expect(TRAIT_FACET_ROOT_SEARCH_MIN_LENGTH).toBe(2);
		expect(TRAIT_FACET_BUCKET_SEARCH_MIN_LENGTH).toBe(1);
		expect(hasRootTraitValueSearch('a')).toBe(false);
		expect(hasRootTraitValueSearch(' ab ')).toBe(true);
		expect(hasBucketTraitValueSearch(' b ')).toBe(true);
	});

	it('filters set-like facet values without searching range facets', () => {
		const hat = facet('Hat', TRAIT_FILTER_DISPLAY_KIND.Set, ['Beanie', 'Cap']);
		const level = facet('Level', TRAIT_FILTER_DISPLAY_KIND.Range, ['7']);

		expect(filterTraitFacetValuesByBucketSearch(hat, 'bea')).toEqual([
			{ value: 'Beanie', tokenCount: 1, marketplaceBiddingSupported: true }
		]);
		expect(filterTraitFacetValuesByBucketSearch(hat, 'b')).toEqual([
			{ value: 'Beanie', tokenCount: 1, marketplaceBiddingSupported: true }
		]);
		expect(filterTraitFacetValuesByBucketSearch(hat, 'blue*')).toEqual([]);
		expect(filterTraitFacetValuesByBucketSearch(level, '7')).toEqual([]);
	});

	it('filters root-level facet buckets to matching set-like traits only', () => {
		const facets = [
			facet('Hat', TRAIT_FILTER_DISPLAY_KIND.Set, ['Beanie', 'Cap']),
			facet('Background', TRAIT_FILTER_DISPLAY_KIND.Set, ['Blue']),
			facet('Level', TRAIT_FILTER_DISPLAY_KIND.Range, ['7'])
		];

		expect(filterTraitFacetsByRootSearch(facets, 'bl').map((item) => item.key)).toEqual([
			'Background'
		]);
		expect(filterTraitFacetsByRootSearch(facets, 'b').map((item) => item.key)).toEqual([
			'Hat',
			'Background',
			'Level'
		]);
		expect(filterTraitFacetsByRootSearch(facets, '').map((item) => item.key)).toEqual([
			'Hat',
			'Background',
			'Level'
		]);
	});

	it('treats whitespace-only root searches as empty', () => {
		expect(hasRootTraitValueSearch('   ')).toBe(false);
		expect(hasBucketTraitValueSearch('   ')).toBe(false);
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
