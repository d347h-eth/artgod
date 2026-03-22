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
				onReset: () => {}
			}
		});

		expect(body).toContain('>traits<');
		expect(body).toContain('>reset<');
		expect(body).toContain('class="facet-panel-controls-row"');
	});
});
