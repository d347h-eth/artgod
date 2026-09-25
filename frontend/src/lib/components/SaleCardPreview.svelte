<script lang="ts">
	import type { ApiChain, ApiCollection, ApiCollectionMediaState } from '$lib/api-types';
	import TokenCardTile from './TokenCardTile.svelte';
	import { getTokenPreviewController } from './token-preview-controller';
	import { buildTokenDetailHref } from '$lib/token-browser-query';
	import { buildAskMarketPrice } from '$lib/market-price';
	import { openseaItemHref } from '$lib/marketplace-links';
	import type { SaleMedia, SaleMediaLoader, SalePreviewTarget } from '$lib/price-chart/media';

	let {
		target,
		pinned,
		loader,
		chain,
		collection,
		media,
		basePath
	}: {
		target: SalePreviewTarget;
		pinned: boolean;
		loader: SaleMediaLoader;
		chain: ApiChain;
		collection: ApiCollection;
		media: ApiCollectionMediaState;
		basePath: string;
	} = $props();
	const tokenPreview = getTokenPreviewController();
	let token = $state.raw<SaleMedia | null>(null);
	let loading = $state(true),
		revision = $state(0);
	let viewportWidth = $state(0),
		viewportHeight = $state(0);
	let width = $state(410),
		height = $state(480);
	const previewTokenId = $derived(target.tokenId);
	const left = $derived(
		Math.max(
			8,
			Math.min(
				target.x + 14 + width > viewportWidth ? target.x - width - 14 : target.x + 14,
				viewportWidth - width - 8
			)
		)
	);
	const top = $derived(
		Math.max(
			8,
			Math.min(
				target.y + 14 + height > viewportHeight ? target.y - height - 14 : target.y + 14,
				viewportHeight - height - 8
			)
		)
	);
	const ask = $derived(
		token
			? buildAskMarketPrice({
					rawPrice: token.listingPrice,
					currencyAddress: token.listingCurrency,
					href: openseaItemHref({
						chainSlug: chain.slug,
						collectionAddress: collection.address,
						tokenId: token.tokenId
					})
				})
			: null
	);
	$effect(() => {
		const id = previewTokenId;
		revision;
		let cancelled = false;
		token = null;
		loading = true;
		void loader.load(id, true).then((result) => {
			if (cancelled) return;
			token = result;
			loading = false;
		});
		return () => {
			cancelled = true;
		};
	});
</script>

<svelte:window bind:innerWidth={viewportWidth} bind:innerHeight={viewportHeight} />
<div class="sale-card-preview" class:pinned
	role={pinned ? 'region' : 'tooltip'} aria-label={`Token ${target.tokenId} card`}
	bind:offsetWidth={width} bind:offsetHeight={height}
	style:left={`${left}px`} style:top={`${top}px`}>
	<div inert={!pinned}>
	{#if token}
		<TokenCardTile {chain} {collection} {token} {tokenPreview}
			href={buildTokenDetailHref({ basePath, tokenId: token.tokenId })}
			selectedMediaMode={media.selectedMode} availableMediaModes={media.availableModes}
			mediaPreference={media.preference} marketPrices={ask ? [ask] : []} />
	{:else}
		<div class="sale-card-pending">
			{#if loading}<span class="muted" role="status">loading…</span>
			{:else if pinned}<button class="facet-panel-action-button" onclick={() => revision++}>retry</button>
			{:else}<span class="muted">hover again to retry</span>{/if}
		</div>
	{/if}
	</div>
</div>

<style>
	.sale-card-preview {
		position: fixed;
		z-index: 80;
		pointer-events: none;
		background: var(--c-bg);
		width: calc(var(--token-grid-media-height) + 0.5rem + 2px);
		max-width: calc(100vw - 16px);
		max-height: calc(100dvh - 16px);
		overflow: auto;
	}
	.pinned {
		pointer-events: auto;
	}
	.sale-card-pending {
		height: calc(var(--token-grid-media-height) + 5rem);
		display: grid;
		place-items: center;
	}
</style>
