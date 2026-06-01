<script lang="ts">
	import type { ApiBiddingBidBook } from '$lib/api-types';
	import {
		bidBookRefreshPaceLabel,
		bidBookRefreshPaceTitle,
		formatBidBookFreshness
	} from '$lib/bidding-bid-book-source';
	import type { BidBookOwnStatusBadge } from '$lib/bidding-bid-book-own-status';

	let {
		bidBook,
		ownStateBadges = [],
		showTraitDemandView = false,
		displayedDemandGroupCount = 0
	}: {
		bidBook: ApiBiddingBidBook;
		ownStateBadges?: BidBookOwnStatusBadge[];
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
		{#if ownStateBadges.length > 0}
			<div>
				<span class="runtime-k">state</span>
				<span class="runtime-v token-bidding-state-badges">
					{#each ownStateBadges as badge (`${badge.kind}:${badge.label}`)}
						<span class={`bid-book-own-status bid-book-own-status-${badge.kind}`}>
							{badge.label}
						</span>
					{/each}
				</span>
			</div>
		{/if}
	</div>

	{#if bidBook.state.lastError}
		<p class="runtime-error bid-book-error" role="alert">{bidBook.state.lastError}</p>
	{/if}
</section>
