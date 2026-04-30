<script lang="ts">
	type MaybePromise<T> = T | Promise<T>;

	let {
		hasActiveFilters,
		collapsed,
		onToggleCollapsed,
		onReset
	}: {
		hasActiveFilters: boolean;
		collapsed: boolean;
		onToggleCollapsed: () => MaybePromise<void>;
		onReset: () => MaybePromise<void>;
	} = $props();

	function onToggleClick(): void {
		void onToggleCollapsed();
	}

	function onResetClick(): void {
		void onReset();
	}
</script>

<div class="facet-panel-controls-row">
	<button
		class="facet-panel-action-button facet-collapse-button"
		type="button"
		aria-label={collapsed ? 'expand traits panel' : 'collapse traits panel'}
		title="toggle traits panel"
		onclick={onToggleClick}
	>
		filter
	</button>
	{#if hasActiveFilters}
		<button
			class="facet-panel-action-button facet-reset-button"
			type="button"
			onclick={onResetClick}
		>
			reset
		</button>
	{/if}
</div>
