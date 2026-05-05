<script lang="ts">
	import type {
		ApiChain,
		ApiCollection,
		ApiCollectionMediaMode,
		ApiTokenCard
	} from '$lib/api-types';
	import MarketPriceIcon from '$lib/components/MarketPriceIcon.svelte';
	import TokenMediaPreviewTrigger from '$lib/components/TokenMediaPreviewTrigger.svelte';
	import type { MarketPriceItem } from '$lib/market-price';
	import type {
		TokenPreviewAdjacentResolver,
		TokenPreviewController
	} from '$lib/components/token-preview-controller';

	let {
		chain,
		collection,
		token,
		href,
		selectedMediaMode,
		availableMediaModes,
		tokenPreview,
		adjacentTokenResolver = null,
		priceLabel = null,
		priceHref = null,
		priceTitle = null,
		marketPrices = [],
		metaLabel = null
	}: {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		token: ApiTokenCard;
		href: string;
		selectedMediaMode: string;
		availableMediaModes: ApiCollectionMediaMode[];
		tokenPreview: TokenPreviewController;
		adjacentTokenResolver?: TokenPreviewAdjacentResolver | null;
		priceLabel?: string | null;
		priceHref?: string | null;
		priceTitle?: string | null;
		marketPrices?: MarketPriceItem[];
		metaLabel?: string | null;
	} = $props();
</script>

<article class="token-grid-card">
	<TokenMediaPreviewTrigger
		chainRef={chain?.slug ?? null}
		collectionRef={collection?.slug ?? null}
		tokenId={token.tokenId}
		image={token.image}
		{selectedMediaMode}
		{availableMediaModes}
		{tokenPreview}
		{adjacentTokenResolver}
		mode="grid"
		containerClass="token-grid-media"
		imageClass="token-grid-thumb"
		emptyClass="token-grid-thumb token-grid-thumb-empty token-thumb-empty"
	/>
	<div class="token-grid-meta">
		<a class="mono token-grid-id" href={href}>{token.tokenId}</a>
		{#if token.traitSummary}
			<div class="mono token-grid-traits">{token.traitSummary}</div>
		{/if}
		{#if marketPrices.length > 0}
			<div class="mono token-grid-market-prices" aria-label="market prices">
				{#each marketPrices as price}
					<span class={`token-grid-market-price ${price.kind}-price`} title={price.title ?? undefined}>
						<MarketPriceIcon kind={price.kind} />
						{#if price.href}
							<a
								class="token-price-link"
								href={price.href}
								target="_blank"
								rel="noreferrer noopener"
							>
								{price.label}
							</a>
						{:else}
							<span>{price.label}</span>
						{/if}
					</span>
				{/each}
			</div>
		{:else if priceLabel}
			<div class="mono token-grid-price" title={priceTitle ?? undefined}>
				{#if priceHref}
					<a
						class="token-price-link"
						href={priceHref}
						target="_blank"
						rel="noreferrer noopener"
					>
						{priceLabel}
					</a>
				{:else}
					{priceLabel}
				{/if}
			</div>
		{/if}
		{#if metaLabel}
			<div class="mono token-grid-secondary-meta">{metaLabel}</div>
		{/if}
	</div>
</article>
