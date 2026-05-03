import { describe, expect, it, vi } from 'vitest';
import { runTraitFacetPanelControlAction } from './trait-facet-panel-control-action';

describe('runTraitFacetPanelControlAction', () => {
	it('uses normal toggle behavior when filters are active', async () => {
		const onToggleCollapsed = vi.fn();

		await runTraitFacetPanelControlAction({
			hasActiveFilters: true,
			collapsed: false,
			onToggleCollapsed,
			filterModes: [
				{ value: 'or', label: 'or' },
				{ value: 'and', label: 'and' }
			],
			selectedFilterMode: 'or',
			onFilterModeChange: vi.fn()
		});

		expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
	});

	it('cycles filter mode before collapsing when no filters are active', async () => {
		const onSetCollapsed = vi.fn();
		const onFilterModeChange = vi.fn();

		await runTraitFacetPanelControlAction({
			hasActiveFilters: false,
			collapsed: false,
			onToggleCollapsed: vi.fn(),
			onSetCollapsed,
			filterModes: [
				{ value: 'or', label: 'or' },
				{ value: 'and', label: 'and' }
			],
			selectedFilterMode: 'or',
			onFilterModeChange
		});

		expect(onFilterModeChange).toHaveBeenCalledWith('and');
		expect(onSetCollapsed).not.toHaveBeenCalled();
	});

	it('collapses and resets to first mode after the last mode', async () => {
		const onSetCollapsed = vi.fn();
		const onFilterModeChange = vi.fn();

		await runTraitFacetPanelControlAction({
			hasActiveFilters: false,
			collapsed: false,
			onToggleCollapsed: vi.fn(),
			onSetCollapsed,
			filterModes: [
				{ value: 'or', label: 'or' },
				{ value: 'and', label: 'and' }
			],
			selectedFilterMode: 'and',
			onFilterModeChange
		});

		expect(onSetCollapsed).toHaveBeenCalledWith(true);
		expect(onFilterModeChange).toHaveBeenCalledWith('or');
	});
});
