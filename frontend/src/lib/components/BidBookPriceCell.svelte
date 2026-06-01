<script lang="ts">
	import type { ApiBiddingBidBookRow } from '$lib/api-types';
	import { TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND } from '@artgod/shared/types';

	type MaybePromise<T> = T | Promise<T>;

	let {
		bid,
		quantityPrefix,
		price,
		actionLabel = null,
		onSelect = null
	}: {
		bid: ApiBiddingBidBookRow;
		quantityPrefix: string | null;
		price: string;
		actionLabel?: string | null;
		onSelect?: ((bid: ApiBiddingBidBookRow) => MaybePromise<void>) | null;
	} = $props();

	const canShowAction = $derived(actionLabel !== null && onSelect !== null);

	function hasOpenSeaOrderHash(): boolean {
		return bid.materialization.kind === TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.MarketBid;
	}

	function ownIntentJobId(): string | null {
		return bid.materialization.kind ===
			TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent
			? bid.materialization.jobId
			: null;
	}
</script>

<td class="mono bid-book-price bid-book-col-right">
	{#if hasOpenSeaOrderHash()}
		<span hidden data-open-sea-order-hash={bid.orderId}></span>
	{:else if ownIntentJobId()}
		<span hidden data-bidding-job-id={ownIntentJobId()}></span>
	{/if}
	<span class="bid-book-price-value">
		<span
			class="bid-book-price-quantity"
			class:bid-book-price-quantity-empty={quantityPrefix === null}
		>
			{quantityPrefix ?? ''}
		</span>
		<span class="bid-book-price-amount">{price}</span>
	</span>
	{#if canShowAction}
		<button
			type="button"
			class="button-link bid-book-row-action"
			onclick={() => void onSelect?.(bid)}
		>
			{actionLabel}
		</button>
	{/if}
</td>
