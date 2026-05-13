<script lang="ts">
	import type { ApiTokenAttribute, ApiTraitRangeFilter } from '$lib/api-types';
	import SelectedTraitFilterSlugs from '$lib/components/SelectedTraitFilterSlugs.svelte';
	import type { TraitFacetFilterModeOption } from '$lib/components/trait-facet-panel-control-action';
	import { removeSelectedTrait, removeTraitRangeFilter } from '$lib/trait-filters';

	type MaybePromise<T> = T | Promise<T>;

	let {
		hasActiveFilters,
		collapsed,
		onToggleCollapsed,
		onReset,
		filterModes = [],
		selectedFilterMode = null,
		onFilterModeChange = null,
		selectedTraits = [],
		selectedRanges = [],
		onSelectedFiltersChange
	}: {
		hasActiveFilters: boolean;
		collapsed: boolean;
		onToggleCollapsed: () => MaybePromise<void>;
		onReset: () => MaybePromise<void>;
		filterModes?: TraitFacetFilterModeOption[];
		selectedFilterMode?: string | null;
		onFilterModeChange?: ((value: string) => MaybePromise<void>) | null;
		selectedTraits?: ApiTokenAttribute[];
		selectedRanges?: ApiTraitRangeFilter[];
		onSelectedFiltersChange: (
			traits: ApiTokenAttribute[],
			ranges: ApiTraitRangeFilter[]
		) => MaybePromise<void>;
	} = $props();

	function currentMode(): TraitFacetFilterModeOption | null {
		return filterModes.find((mode) => mode.value === selectedFilterMode) ?? null;
	}

	async function onToggleClick(): Promise<void> {
		await onToggleCollapsed();
	}

	function hasModeControl(): boolean {
		return filterModes.length > 1 && currentMode() !== null && onFilterModeChange !== null;
	}

	function modeLabel(): string {
		return currentMode()?.label.toUpperCase() ?? '';
	}

	async function onModeClick(): Promise<void> {
		if (!onFilterModeChange || filterModes.length === 0) return;
		const currentIndex = filterModes.findIndex((mode) => mode.value === selectedFilterMode);
		const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % filterModes.length : 0;
		await onFilterModeChange(filterModes[nextIndex].value);
	}

	function onResetClick(): void {
		void onReset();
	}

	function onRemoveTrait(trait: ApiTokenAttribute): void {
		const nextTraits = removeSelectedTrait(selectedTraits, trait.key, trait.value);
		void onSelectedFiltersChange(nextTraits, selectedRanges);
	}

	function onRemoveRange(range: ApiTraitRangeFilter): void {
		const nextRanges = removeTraitRangeFilter(selectedRanges, range.key);
		void onSelectedFiltersChange(selectedTraits, nextRanges);
	}
</script>

<div class="facet-panel-controls-row">
	<button
		class="facet-panel-action-button facet-collapse-button"
		class:facet-collapse-button-active={!collapsed}
		type="button"
		aria-label={collapsed ? 'expand traits panel' : 'collapse traits panel'}
		title="toggle traits panel"
		onclick={() => void onToggleClick()}
	>
		filter
	</button>
	{#if hasModeControl()}
		<button
			class="facet-panel-action-button facet-filter-mode-button"
			type="button"
			aria-label={`switch trait filter join mode from ${modeLabel()}`}
			title="switch trait filter join mode"
			onclick={() => void onModeClick()}
		>
			{modeLabel()}
		</button>
	{/if}
	{#if hasActiveFilters}
		<button
			class="facet-panel-action-button facet-reset-button"
			type="button"
			onclick={onResetClick}
		>
			reset
		</button>
	{/if}

	<SelectedTraitFilterSlugs
		{selectedTraits}
		selectedRanges={selectedRanges}
		onRemoveTrait={onRemoveTrait}
		onRemoveRange={onRemoveRange}
	/>
</div>
