<script lang="ts">
	type MaybePromise<T> = T | Promise<T>;

	let {
		totalItems,
		summary,
		onSelectAll,
		onClear
	}: {
		totalItems: number;
		summary: string | null;
		onSelectAll: () => MaybePromise<void>;
		onClear: () => MaybePromise<void>;
	} = $props();

	function handleSelectAll(): void {
		void onSelectAll();
	}

	function handleClear(): void {
		void onClear();
	}
</script>

<div class="bidding-selection-controls" aria-label="Token bidding selection">
	<button
		type="button"
		class="facet-panel-action-button bidding-select-all-button"
		disabled={totalItems === 0}
		onclick={handleSelectAll}
	>
		select all
	</button>
	{#if summary}
		<span class="mono bidding-selection-summary">{summary}</span>
		<button type="button" class="button-link bidding-selection-clear-button" onclick={handleClear}>
			clear
		</button>
	{/if}
</div>
