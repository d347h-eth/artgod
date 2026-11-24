<script lang="ts">
	import type {
		BidBookBrowseCriterion,
		BidBookScopeTraits,
		BidBookTraitValueHref
	} from '$lib/bidding-bid-book-display';
	import { trimBidBookTraitText } from '$lib/bidding-bid-book-display';
	import { canRepresentTraitFilters } from '$lib/trait-filters';
	import {
		formatTradingTraitCriterionValue,
		isTradingNumericTraitRange
	} from '@artgod/shared/types';
	import { biddingTraitCriteriaKey } from '@artgod/shared/trading/offer-trait-criteria';

	let {
		traits,
		browseCriterion = (native) => native,
		traitValueHref = null
	}: {
		traits: BidBookScopeTraits;
		browseCriterion?: BidBookBrowseCriterion;
		traitValueHref?: BidBookTraitValueHref | null;
	} = $props();

	function browseValueHref(criterion: BidBookScopeTraits[number] | null): string | null {
		if (!traitValueHref || !criterion || isTradingNumericTraitRange(criterion)) return null;
		const filter = { key: criterion.type, value: criterion.value };
		return canRepresentTraitFilters([filter], []) ? traitValueHref(filter) : null;
	}
</script>

<span class="bid-book-demand-trait-list">
	{#each traits as native, traitIndex (biddingTraitCriteriaKey([native]))}
		{@const filter = browseCriterion(native)}
		{@const trait = filter ?? native}
		{@const href = browseValueHref(filter)}
		{@const value = trimBidBookTraitText(formatTradingTraitCriterionValue(trait))}
		<span class="bid-book-demand-trait-entry">
			{#if traitIndex > 0}
				<span class="bid-book-demand-trait-separator">+</span>
			{/if}
			<span class="bid-book-demand-trait">
				<span class="bid-book-demand-trait-key">{trimBidBookTraitText(trait.type)}</span>
				<span class="bid-book-demand-trait-equals">=</span>
				{#if href}
					<a class="bid-book-demand-trait-value-link" {href}>{value}</a>
				{:else}
					<span class="bid-book-demand-trait-value">{value}</span>
				{/if}
			</span>
		</span>
	{/each}
</span>
