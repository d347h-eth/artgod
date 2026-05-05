<script lang="ts">
	import type { MarketPriceKind } from '$lib/market-price';

	let { kind }: { kind: MarketPriceKind } = $props();
</script>

<svg class="market-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
	<path
		d="M2.75 21.25h17.5v-7.25M2.75 21.25V3.75H10"
		fill="none"
		stroke="currentColor"
		stroke-width="2.25"
		stroke-linecap="square"
		stroke-linejoin="miter"
	/>
	{#if kind === 'ask'}
		<path
			d="M13.75 3.75h6.5V10.25M20.25 3.75 9.75 14.25"
			fill="none"
			stroke="currentColor"
			stroke-width="2.25"
			stroke-linecap="square"
			stroke-linejoin="miter"
		/>
	{:else}
		<path
			d="M20.25 3.75 9.75 14.25M9.75 14.25h6.5M9.75 14.25v-6.5"
			fill="none"
			stroke="currentColor"
			stroke-width="2.25"
			stroke-linecap="square"
			stroke-linejoin="miter"
		/>
	{/if}
</svg>
