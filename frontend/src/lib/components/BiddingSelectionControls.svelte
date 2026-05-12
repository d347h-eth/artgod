<script lang="ts">
	type MaybePromise<T> = T | Promise<T>;

	let {
		summary,
		showTraitAction = false,
		showTokenAction = true,
		tokenActionLabel = 'bid on tokens',
		tokenActionDisabled = false,
		onBidOnTraits = null,
		onBidOnTokens,
		onClear
	}: {
		summary: string | null;
		showTraitAction?: boolean;
		showTokenAction?: boolean;
		tokenActionLabel?: string;
		tokenActionDisabled?: boolean;
		onBidOnTraits?: (() => MaybePromise<void>) | null;
		onBidOnTokens: () => MaybePromise<void>;
		onClear: () => MaybePromise<void>;
	} = $props();

	function handleBidOnTraits(): void {
		void onBidOnTraits?.();
	}

	function handleBidOnTokens(): void {
		void onBidOnTokens();
	}

	function handleClear(): void {
		void onClear();
	}
</script>

<div class="bidding-selection-controls" aria-label="Bidding target selection">
	{#if showTraitAction && onBidOnTraits}
		<button
			type="button"
			class="facet-panel-action-button bidding-select-all-button"
			onclick={handleBidOnTraits}
		>
			bid on traits
		</button>
	{/if}
	{#if showTokenAction}
		<button
			type="button"
			class="facet-panel-action-button bidding-select-all-button"
			disabled={tokenActionDisabled}
			onclick={handleBidOnTokens}
		>
			{tokenActionLabel}
		</button>
	{/if}
	{#if summary}
		<span class="mono bidding-selection-summary">{summary}</span>
		<button type="button" class="button-link bidding-selection-clear-button" onclick={handleClear}>
			clear
		</button>
	{/if}
</div>
