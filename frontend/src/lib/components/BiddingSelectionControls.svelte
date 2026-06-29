<script lang="ts">
	import {
		BIDDING_SELECTION_ACTION_LABEL,
		BIDDING_SELECTION_JOB_ACTION,
		type BiddingSelectionJobAction
	} from '$lib/bidding-selection-actions';

	type MaybePromise<T> = T | Promise<T>;

	let {
		summary,
		showTraitAction = false,
		showTokenAction = true,
		showCollectionAction = false,
		showTierAction = false,
		showJobActions = false,
		tierActionActive = false,
		tokenActionLabel = BIDDING_SELECTION_ACTION_LABEL.BidOnAllTokens,
		tokenActionDisabled = false,
		collectionActionLabel = BIDDING_SELECTION_ACTION_LABEL.PlaceCollectionBid,
		collectionActionDisabled = false,
		jobActionDisabled = false,
		jobActionBusy = null,
		armedJobAction = null,
		jobActionMessage = null,
		jobActionError = null,
		onBidOnTraits = null,
		onBidOnTokens,
		onBidOnCollection = null,
		onToggleTiers = null,
		onJobAction = null,
		onClear
	}: {
		summary: string | null;
		showTraitAction?: boolean;
		showTokenAction?: boolean;
		showCollectionAction?: boolean;
		showTierAction?: boolean;
		showJobActions?: boolean;
		tierActionActive?: boolean;
		tokenActionLabel?: string;
		tokenActionDisabled?: boolean;
		collectionActionLabel?: string;
		collectionActionDisabled?: boolean;
		jobActionDisabled?: boolean;
		jobActionBusy?: BiddingSelectionJobAction | null;
		armedJobAction?: BiddingSelectionJobAction | null;
		jobActionMessage?: string | null;
		jobActionError?: string | null;
		onBidOnTraits?: (() => MaybePromise<void>) | null;
		onBidOnTokens: () => MaybePromise<void>;
		onBidOnCollection?: (() => MaybePromise<void>) | null;
		onToggleTiers?: (() => MaybePromise<void>) | null;
		onJobAction?: ((action: BiddingSelectionJobAction) => MaybePromise<void>) | null;
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

	function handleJobAction(action: BiddingSelectionJobAction): void {
		void onJobAction?.(action);
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
	{#if showJobActions && onJobAction}
		<button
			type="button"
			class="facet-panel-action-button bidding-select-all-button token-bidding-action-positive"
			class:token-bidding-action-armed={armedJobAction === BIDDING_SELECTION_JOB_ACTION.Activate}
			disabled={jobActionDisabled || jobActionBusy !== null}
			onclick={() => handleJobAction(BIDDING_SELECTION_JOB_ACTION.Activate)}
		>
			{jobActionBusy === BIDDING_SELECTION_JOB_ACTION.Activate
				? 'activating...'
				: BIDDING_SELECTION_ACTION_LABEL.Activate}
		</button>
		<button
			type="button"
			class="facet-panel-action-button bidding-select-all-button token-bidding-action-negative"
			class:token-bidding-action-armed={armedJobAction === BIDDING_SELECTION_JOB_ACTION.Pause}
			disabled={jobActionDisabled || jobActionBusy !== null}
			onclick={() => handleJobAction(BIDDING_SELECTION_JOB_ACTION.Pause)}
		>
			{jobActionBusy === BIDDING_SELECTION_JOB_ACTION.Pause
				? 'pausing...'
				: BIDDING_SELECTION_ACTION_LABEL.Pause}
		</button>
		<button
			type="button"
			class="facet-panel-action-button bidding-select-all-button token-bidding-action-negative"
			class:token-bidding-action-armed={armedJobAction === BIDDING_SELECTION_JOB_ACTION.Archive}
			disabled={jobActionDisabled || jobActionBusy !== null}
			onclick={() => handleJobAction(BIDDING_SELECTION_JOB_ACTION.Archive)}
		>
			{jobActionBusy === BIDDING_SELECTION_JOB_ACTION.Archive
				? 'archiving...'
				: BIDDING_SELECTION_ACTION_LABEL.Archive}
		</button>
	{/if}
	{#if summary}
		<span class="mono bidding-selection-summary">{summary}</span>
		<button type="button" class="button-link bidding-selection-clear-button" onclick={handleClear}>
			{BIDDING_SELECTION_ACTION_LABEL.Clear}
		</button>
	{/if}
	{#if jobActionMessage}
		<span class="runtime-pass bidding-selection-feedback">{jobActionMessage}</span>
	{/if}
	{#if jobActionError}
		<span class="runtime-error bidding-selection-feedback" role="alert">{jobActionError}</span>
	{/if}
</div>
