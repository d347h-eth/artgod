<script lang="ts">
	import type {
		BidBookScopeTraits,
		BidBookTraitValueHref
	} from '$lib/bidding-bid-book-display';
	import { trimBidBookTraitText } from '$lib/bidding-bid-book-display';

	let {
		traits,
		traitValueHref = null
	}: {
		traits: BidBookScopeTraits;
		traitValueHref?: BidBookTraitValueHref | null;
	} = $props();
</script>

<span class="bid-book-demand-trait-list">
	{#each traits as trait, traitIndex (`${trait.type}:${trait.value}`)}
		<span class="bid-book-demand-trait-entry">
			{#if traitIndex > 0}
				<span class="bid-book-demand-trait-separator">+</span>
			{/if}
			<span class="bid-book-demand-trait">
				<span class="bid-book-demand-trait-key">{trimBidBookTraitText(trait.type)}</span>
				<span class="bid-book-demand-trait-equals">=</span>
				{#if traitValueHref}
					<a
						class="bid-book-demand-trait-value-link"
						href={traitValueHref({
							key: trait.type,
							value: trait.value
						})}
					>
						{trimBidBookTraitText(trait.value)}
					</a>
				{:else}
					<span class="bid-book-demand-trait-value">{trimBidBookTraitText(trait.value)}</span>
				{/if}
			</span>
		</span>
	{/each}
</span>
