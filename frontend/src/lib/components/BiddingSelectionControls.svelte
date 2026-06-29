<script lang="ts">
	import { BIDDING_SELECTION_ACTION_LABEL } from '$lib/bidding-selection-actions';

	type MaybePromise<T> = T | Promise<T>;

	let {
		summary,
		showTraitAction = false,
		showTokenAction = true,
		showCollectionAction = false,
		showTierAction = false,
		tierActionActive = false,
		tokenActionLabel = BIDDING_SELECTION_ACTION_LABEL.BidOnAllTokens,
		tokenActionDisabled = false,
		collectionActionLabel = BIDDING_SELECTION_ACTION_LABEL.PlaceCollectionBid,
		collectionActionDisabled = false,
		onBidOnTraits = null,
		onBidOnTokens,
		onBidOnCollection = null,
		onToggleTiers = null,
		onClear
	}: {
		summary: string | null;
		showTraitAction?: boolean;
		showTokenAction?: boolean;
		showCollectionAction?: boolean;
		showTierAction?: boolean;
		tierActionActive?: boolean;
		tokenActionLabel?: string;
		tokenActionDisabled?: boolean;
		collectionActionLabel?: string;
		collectionActionDisabled?: boolean;
		onBidOnTraits?: (() => MaybePromise<void>) | null;
		onBidOnTokens: () => MaybePromise<void>;
		onBidOnCollection?: (() => MaybePromise<void>) | null;
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

	function handleBidOnCollection(): void {
		void onBidOnCollection?.();
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
			{BIDDING_SELECTION_ACTION_LABEL.Tiers}
		</button>
	{/if}
	{#if showTraitAction && onBidOnTraits}
		<button
			type="button"
			class="facet-panel-action-button bidding-select-all-button"
			onclick={handleBidOnTraits}
		>
			{BIDDING_SELECTION_ACTION_LABEL.BidOnTraits}
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
	{#if showCollectionAction && onBidOnCollection}
		<button
			type="button"
			class="facet-panel-action-button bidding-select-all-button"
			disabled={collectionActionDisabled}
			onclick={handleBidOnCollection}
		>
			{collectionActionLabel}
		</button>
	{/if}
	{#if summary}
		<span class="mono bidding-selection-summary">{summary}</span>
		<button type="button" class="button-link bidding-selection-clear-button" onclick={handleClear}>
			{BIDDING_SELECTION_ACTION_LABEL.Clear}
		</button>
	{/if}
</div>
