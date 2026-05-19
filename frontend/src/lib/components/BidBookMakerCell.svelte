<script lang="ts">
	import type { ApiBiddingBidBookRow } from '$lib/api-types';
	import { ownBidStatusBadges } from '$lib/bidding-bid-book-own-status';

	let {
		bid,
		href,
		highlighted = false,
		onSetHighlighted,
		onClearHighlighted
	}: {
		bid: ApiBiddingBidBookRow;
		href: string;
		highlighted?: boolean;
		onSetHighlighted: (bid: ApiBiddingBidBookRow) => void;
		onClearHighlighted: () => void;
	} = $props();

	const ownBadges = $derived(ownBidStatusBadges(bid));
	const title = $derived(bid.maker.isOwn ? bid.maker.address : undefined);
	const label = $derived(bid.maker.isOwn ? bid.maker.label : bid.maker.address);
</script>

<td class="mono bid-book-maker-cell bid-book-col-center">
	<a
		{href}
		class:bid-book-maker-highlight={highlighted}
		onpointerenter={() => onSetHighlighted(bid)}
		onpointerleave={onClearHighlighted}
		onfocus={() => onSetHighlighted(bid)}
		onblur={onClearHighlighted}
		{title}
	>
		{label}
	</a>
	{#each ownBadges as badge (`${badge.kind}:${badge.label}`)}
		<span class={`bid-book-own-status bid-book-own-status-${badge.kind}`}>
			{badge.label}
		</span>
	{/each}
</td>
