<script lang="ts">
	import { onMount } from 'svelte';
	import type { RealizedSale } from '@artgod/shared/types/price-history';
	import type { BlockExplorerConfig } from '@artgod/shared/config/block-explorer';
	import type { SaleMediaLoader, SalePreviewTarget } from '$lib/price-chart/media';
	import { blockExplorerTransactionHref } from '$lib/marketplace-links';
	import { buildOwnerTokensHref, buildTokenDetailHref } from '$lib/token-browser-query';
	import { joinPath } from '$lib/route-paths';
	import {
		ethText,
		salePriceText,
		saleActionColor,
		SALE_CURRENCY_LABEL
	} from '$lib/price-chart/model';
	import SaleTokenThumbnail from './SaleTokenThumbnail.svelte';
	let {
		sales,
		pinned,
		clearPin,
		basePath,
		blockExplorer,
		loader,
		onpreview
	}: {
		sales: RealizedSale[];
		pinned: boolean;
		clearPin: () => void;
		basePath: string;
		blockExplorer: BlockExplorerConfig;
		loader: SaleMediaLoader;
		onpreview: (target: SalePreviewTarget | null) => void;
	} = $props();
	const PAGE_SIZE = 50;
	let pageIndex = $state(0),
		now = $state(Date.now());
	let scroller: HTMLDivElement;
	$effect(() => {
		sales;
		pageIndex = 0;
		if (scroller) scroller.scrollTop = 0;
		onpreview(null);
	});
	onMount(() => {
		const timer = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(timer);
	});
	function relativeTime(timestamp: number) {
		const seconds = Math.max(0, Math.floor(now / 1000) - timestamp);
		if (seconds < 60) return seconds + 's';
		if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
		if (seconds < 86400) return Math.floor(seconds / 3600) + 'h';
		const days = Math.floor(seconds / 86400);
		if (days < 30) return days + 'd';
		if (days < 365) return Math.floor(days / 30) + 'mo';
		return Math.floor(days / 365) + 'y';
	}
	function ownerHref(address: string) {
		return buildOwnerTokensHref({
			basePath: joinPath(basePath, 'holders/' + encodeURIComponent(address)),
			selectedTraits: [],
			selectedTraitRanges: []
		});
	}
	function changePage(step: number) {
		pageIndex += step;
		scroller.scrollTop = 0;
		onpreview(null);
	}
</script>

<aside class="sale-sidebar" aria-label="Sales" data-pinned={pinned}>
	<div class="sale-sidebar-heading"><span>sales · {sales.length}</span>{#if pinned}<button class="facet-panel-action-button" onclick={clearPin}>unpin</button>{/if}</div>
	<div class="sales-scroll" bind:this={scroller} onscroll={() => onpreview(null)}>
		<div class="sales-table" role="table" aria-label="Realized sales">
			<div class="sale-row sale-head" role="row"><span role="columnheader">time</span><span role="columnheader" aria-label="Token">NFT</span><span role="columnheader" class="sale-price">price</span><span role="columnheader">seller</span><span role="columnheader">buyer</span></div>
			{#each sales.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE) as sale (sale.id)}
				{@const txHref = blockExplorerTransactionHref(sale.txHash, blockExplorer)}
				<div class="sale-row" role="row" data-sale-id={sale.id}>
					<span role="cell"><a class="sale-time" href={txHref ?? undefined} target="_blank" rel="noopener noreferrer" title={new Date(sale.timestamp * 1000).toISOString()}>{relativeTime(sale.timestamp)}</a></span>
					<span role="cell"><SaleTokenThumbnail tokenId={sale.tokenId} href={buildTokenDetailHref({ basePath, tokenId: sale.tokenId })} {loader} {onpreview} /></span>
					<span role="cell" class="sale-price" style:--sale-color={`var(--c-${saleActionColor(sale.action)})`}><a href={txHref ?? undefined} target="_blank" rel="noopener noreferrer" title={ethText(sale.priceWei) + ' ' + sale.currencySymbol}><span class="sale-amount">{salePriceText(sale.priceWei)}</span><small aria-label={sale.currencySymbol}>{SALE_CURRENCY_LABEL[sale.currencySymbol]}</small></a></span>
					<span role="cell">{#if sale.seller}<a class="sale-seller" href={ownerHref(sale.seller)} title={sale.seller}>{sale.seller.slice(2, 8)}</a>{:else}<span class="muted">—</span>{/if}</span>
					<span role="cell">{#if sale.buyer}<a class="sale-buyer" href={ownerHref(sale.buyer)} title={sale.buyer}>{sale.buyer.slice(2, 8)}</a>{:else}<span class="muted">—</span>{/if}</span>
				</div>
			{/each}
		</div>
	</div>
	{#if sales.length > PAGE_SIZE}
		<div class="sale-pagination">
			<button class="facet-panel-action-button" aria-label="Previous sales" disabled={pageIndex === 0} onclick={() => changePage(-1)}>‹</button>
			<span>{pageIndex * PAGE_SIZE + 1}–{Math.min((pageIndex + 1) * PAGE_SIZE, sales.length)}</span>
			<button class="facet-panel-action-button" aria-label="Next sales" disabled={(pageIndex + 1) * PAGE_SIZE >= sales.length} onclick={() => changePage(1)}>›</button>
		</div>
	{/if}
</aside>

<style>
	.sale-sidebar {
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
		border-left: 1px solid var(--c-blue);
		padding-left: 0.35rem;
		font-size: 10px;
	}
	.sale-sidebar-heading {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		min-height: 2rem;
		color: var(--c-sand);
	}
	.sale-sidebar-heading button {
		font-size: 9px;
		padding: 1px 3px;
	}
	.sales-scroll {
		overflow: auto;
		flex: 1;
		min-height: 0;
	}
	.sales-table {
		display: grid;
		grid-template-columns: 4ch 16px minmax(0, max-content) 6ch 6ch;
		column-gap: 8px;
		justify-content: space-between;
	}
	.sale-row {
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns: subgrid;
		align-items: center;
		height: 22px;
		line-height: 1;
	}
	.sale-head {
		position: sticky;
		top: 0;
		background: var(--c-bg);
		color: var(--c-sand);
		border-bottom: 1px solid var(--c-blue);
	}
	.sale-head > span {
		font-size: 8px;
	}
	.sale-row > span {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		height: 100%;
		text-align: right;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.sale-row a {
		display: inline-block;
		max-width: 100%;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.sale-row small {
		font-size: 8px;
		flex-shrink: 0;
		width: 1ch;
	}
	.sale-price {
		padding-right: 12px;
	}
	.sale-price a {
		color: var(--sale-color);
		display: flex;
		align-items: baseline;
		justify-content: flex-end;
		gap: 2px;
	}
	.sale-price a:hover,
	.sale-price a:focus-visible {
		color: var(--c-yellow);
	}
	.sale-amount {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.sale-pagination {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.35rem;
		padding-top: 0.3rem;
	}
</style>
