import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import TraitFacetPanelControls from './TraitFacetPanelControls.svelte';

describe('TraitFacetPanelControls', () => {
	it('renders a toggle button and reset when filters are active', () => {
		const { body } = render(TraitFacetPanelControls, {
			props: {
				hasActiveFilters: true,
				collapsed: true,
				onToggleCollapsed: () => {},
				onReset: () => {},
				onSelectedFiltersChange: () => {}
			}
		});

		expect(body).toContain('>filter<');
		expect(body).toContain('>reset<');
		expect(body).toContain('class="facet-panel-controls-row"');
	});

	it('renders a separate fixed-width filter mode button when mode cycling is configured', () => {
		const { body } = render(TraitFacetPanelControls, {
			props: {
				hasActiveFilters: false,
				collapsed: false,
				onToggleCollapsed: () => {},
				filterModes: [
					{ value: 'or', label: 'or' },
					{ value: 'and', label: 'and' }
				],
				selectedFilterMode: 'or',
				onFilterModeChange: () => {},
				onReset: () => {},
				onSelectedFiltersChange: () => {}
			}
		});

		expect(body).toContain('>filter<');
		expect(body).toContain('>OR<');
		expect(body).toContain('facet-filter-mode-button');
		expect(body).not.toContain('filter [or]');
	});

	it('renders selected trait filter slugs under the main controls', () => {
		const { body } = render(TraitFacetPanelControls, {
			props: {
				hasActiveFilters: true,
				collapsed: false,
				onToggleCollapsed: () => {},
				onReset: () => {},
				selectedTraits: [
					{ key: 'Hat', value: 'Very Long Beanie Value' },
					{ key: 'Mode', value: 'Terrain' }
				],
				selectedRanges: [{ key: 'Level', fromValue: '1', toValue: '20' }],
				onSelectedFiltersChange: () => {}
			}
		});

		expect(body).toContain('class="trait-filter-slugs"');
		expect(body).toContain('title="Hat=Very Long Beanie Value"');
		expect(body).toContain('>Hat=Very Long Bea...');
		expect(body).toContain('>Mode=Terrain<');
		expect(body).toContain('>Level=1..20<');
		expect(body.match(/facet-reset-button trait-filter-slug/g)).toHaveLength(3);
	});
});
