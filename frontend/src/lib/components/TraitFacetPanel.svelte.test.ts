import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import { TRAIT_FILTER_DISPLAY_KIND } from '@artgod/shared/types';
import type { ApiTraitFacet } from '$lib/api-types';
import * as collectionView from '$lib/collection-view';
import TraitFacetPanel from './TraitFacetPanel.svelte';

describe('TraitFacetPanel', () => {
	it('omits only a facet already pinned by the picker and leaves explicit filters removable', () => {
		const pin = { key: 'source scope', value: 'blue' };
		const view = {
			id: 'test-view',
			label: 'Selected scope',
			parent: null,
			pinnedTraits: [pin],
			generation: 1,
			classified: 1,
			ready: 1,
			activeMapperVersion: 'v1',
			availableMapperVersion: 'v1'
		};
		const source = vi.spyOn(collectionView, 'selectedCollectionView');
		source.mockReturnValueOnce(view).mockReturnValueOnce(view);
		const facet: ApiTraitFacet = {
			key: 'Already pinned',
			displayKind: TRAIT_FILTER_DISPLAY_KIND.Set,
			minValue: null,
			maxValue: null,
			values: [{ ...facetValue('Blue', 1), native: pin }]
		};
		const props = {
			facets: [facet, { ...facet, key: 'Other choice', values: [facetValue('Blue', 1)] }],
			selectedTraits: [],
			selectedRanges: [],
			onToggleTrait: () => {},
			onApplyTraitRange: () => {}
		};

		const initial = render(TraitFacetPanel, { props }).body;
		expect(initial).not.toContain(facet.key);
		expect(initial.match(/<summary>/g)).toHaveLength(1);
		expect(initial).toContain('Other choice');
		expect(initial).toContain('type="checkbox"');

		const explicit = render(TraitFacetPanel, {
			props: { ...props, selectedTraits: [{ key: facet.key, value: 'Blue' }] }
		}).body;
		expect(explicit).toContain(facet.key);
		source.mockRestore();
	});

	it('does not render the sidebar body when collapsed', () => {
		const { body } = render(TraitFacetPanel, {
			props: {
				facets: [
					{
						key: 'Hat',
						displayKind: TRAIT_FILTER_DISPLAY_KIND.Set,
						minValue: null,
						maxValue: null,
						values: [facetValue('Beanie', 1)]
					}
				],
				selectedTraits: [{ key: 'Hat', value: 'Beanie' }],
				selectedRanges: [],
				collapsed: true,
				onToggleTrait: () => {},
				onApplyTraitRange: () => {}
			}
		});

		expect(body).not.toContain('class="facet-panel"');
	});

	it('renders clickable min/max hint buttons for range facets', () => {
		const { body } = render(TraitFacetPanel, {
			props: {
				facets: [
					{
						key: 'Level',
						displayKind: TRAIT_FILTER_DISPLAY_KIND.Range,
						minValue: '2',
						maxValue: '7',
						values: []
					}
				],
				selectedTraits: [],
				selectedRanges: [],
				onToggleTrait: () => {},
				onApplyTraitRange: () => {}
			}
		});

		expect(body).toContain('trait-range-hint-button');
		expect(body).toContain('>2</button>');
		expect(body).toContain('>7</button>');
	});

	it('renders a sort toggle for set facets', () => {
		const { body } = render(TraitFacetPanel, {
			props: {
				facets: [
					{
						key: 'Hat',
						displayKind: TRAIT_FILTER_DISPLAY_KIND.Set,
						minValue: null,
						maxValue: null,
						values: [facetValue('Beanie', 1), facetValue('Cap', 3)]
					}
				],
				selectedTraits: [],
				selectedRanges: [],
				onToggleTrait: () => {},
				onApplyTraitRange: () => {}
			}
		});

		expect(body).toContain('trait-sort-button');
		expect(body).toContain('>R</button>');
	});

	it('renders a root search input when set-like facets exist', () => {
		const { body } = render(TraitFacetPanel, {
			props: {
				facets: [
					{
						key: 'Hat',
						displayKind: TRAIT_FILTER_DISPLAY_KIND.Set,
						minValue: null,
						maxValue: null,
						values: [facetValue('Beanie', 1)]
					},
					{
						key: 'Level',
						displayKind: TRAIT_FILTER_DISPLAY_KIND.Range,
						minValue: '2',
						maxValue: '7',
						values: []
					}
				],
				selectedTraits: [],
				selectedRanges: [],
				onToggleTrait: () => {},
				onApplyTraitRange: () => {}
			}
		});

		expect(body).toContain('aria-label="search all traits"');
		expect(body).toContain('placeholder="search all"');
	});

	it('does not render root value search when every facet is range-only', () => {
		const { body } = render(TraitFacetPanel, {
			props: {
				facets: [
					{
						key: 'Level',
						displayKind: TRAIT_FILTER_DISPLAY_KIND.Range,
						minValue: '2',
						maxValue: '7',
						values: []
					}
				],
				selectedTraits: [],
				selectedRanges: [],
				onToggleTrait: () => {},
				onApplyTraitRange: () => {}
			}
		});

		expect(body).not.toContain('aria-label="search all traits"');
		expect(body).not.toContain('placeholder="search all"');
	});
});

function facetValue(value: string, tokenCount: number): ApiTraitFacet['values'][number] {
	return {
		value,
		tokenCount,
		marketplaceBiddingSupported: true
	};
}
