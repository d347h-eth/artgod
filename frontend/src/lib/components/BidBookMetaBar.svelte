<script lang="ts">
	import type { ApiBiddingBidBook } from '$lib/api-types';
	import {
		bidBookRefreshPaceLabel,
		bidBookRefreshPaceTitle,
		formatBidBookFreshness
	} from '$lib/bidding-bid-book-source';

	let {
		bidBook,
		position = null,
		showTraitDemandView = false,
		displayedDemandGroupCount = 0
	}: {
		bidBook: ApiBiddingBidBook;
		position?: string | null;
		showTraitDemandView?: boolean;
		displayedDemandGroupCount?: number;
	} = $props();
</script>

<section class="runtime-section bid-book-summary-panel">
	<div class="runtime-kv-grid bid-book-meta">
		<div>
			<span class="runtime-k">refresh pace</span>
			<span class="runtime-v" title={bidBookRefreshPaceTitle(bidBook.state.source)}>
				{bidBookRefreshPaceLabel(bidBook.state.source)}
			</span>
		</div>
		<div>
			<span class="runtime-k">rows</span>
			<span class="runtime-v">{bidBook.state.rowCount}</span>
		</div>
		{#if showTraitDemandView}
			<div>
				<span class="runtime-k">targets</span>
				<span class="runtime-v">{displayedDemandGroupCount}</span>
			</div>
		{/if}
		<div>
			<span class="runtime-k">updated</span>
			<span class="runtime-v mono">{formatBidBookFreshness(bidBook.state)}</span>
		</div>
		{#if position}
			<div>
				<span class="runtime-k">position</span>
				<span class="runtime-v">{position}</span>
			</div>
		{/if}
	</div>

	{#if bidBook.state.lastError}
		<p class="runtime-error bid-book-error" role="alert">{bidBook.state.lastError}</p>
	{/if}
</section>
