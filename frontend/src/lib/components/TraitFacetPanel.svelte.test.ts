import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import { TRAIT_FILTER_DISPLAY_KIND } from '@artgod/shared/types';
import TraitFacetPanel from './TraitFacetPanel.svelte';

describe('TraitFacetPanel', () => {
	it('does not render the sidebar body when collapsed', () => {
		const { body } = render(TraitFacetPanel, {
			props: {
				facets: [
					{
						key: 'Hat',
						displayKind: TRAIT_FILTER_DISPLAY_KIND.Set,
						minValue: null,
						maxValue: null,
						values: [{ value: 'Beanie', tokenCount: 1 }]
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
						values: [
							{ value: 'Beanie', tokenCount: 1 },
							{ value: 'Cap', tokenCount: 3 }
						]
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
						values: [{ value: 'Beanie', tokenCount: 1 }]
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
