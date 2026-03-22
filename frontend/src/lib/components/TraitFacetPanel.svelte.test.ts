import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import TraitFacetPanel from './TraitFacetPanel.svelte';

describe('TraitFacetPanel', () => {
	it('does not render the sidebar body when collapsed', () => {
		const { body } = render(TraitFacetPanel, {
			props: {
				facets: [{ key: 'Hat', values: [{ value: 'Beanie', tokenCount: 1 }] }],
				selectedTraits: [{ key: 'Hat', value: 'Beanie' }],
				collapsed: true,
				onToggleTrait: () => {}
			}
		});

		expect(body).not.toContain('class="facet-panel"');
	});
});
