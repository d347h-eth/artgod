<script lang="ts">
	type MaybePromise<T> = T | Promise<T>;

	let {
		summary,
		showTraitAction = false,
		showTokenAction = true,
		showTierAction = false,
		tierActionActive = false,
		tokenActionLabel = 'bid on all tokens',
		tokenActionDisabled = false,
		onBidOnTraits = null,
		onBidOnTokens,
		onToggleTiers = null,
		onClear
	}: {
		summary: string | null;
		showTraitAction?: boolean;
		showTokenAction?: boolean;
		showTierAction?: boolean;
		tierActionActive?: boolean;
		tokenActionLabel?: string;
		tokenActionDisabled?: boolean;
		onBidOnTraits?: (() => MaybePromise<void>) | null;
		onBidOnTokens: () => MaybePromise<void>;
		onToggleTiers?: (() => MaybePromise<void>) | null;
		onClear: () => MaybePromise<void>;
	} = $props();

	function handleToggleTiers(): void {
		void onToggleTiers?.();
	}

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
	{#if showTierAction && onToggleTiers}
		<button
			type="button"
			class="facet-panel-action-button bidding-price-tier-toggle"
			class:bidding-price-tier-toggle-active={tierActionActive}
			aria-pressed={tierActionActive}
			onclick={handleToggleTiers}
		>
			tiers
		</button>
	{/if}
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
