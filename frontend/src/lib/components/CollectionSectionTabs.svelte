<script lang="ts">
	import { preferredCollectionBiddingHref } from '$lib/bidding-navigation-preferences';
	import { preferredCollectionTokensHref } from '$lib/token-browser-navigation-preferences';

	let {
		tokensHref,
		tokensBasePath,
		tokensQuery = new URLSearchParams(),
		activitiesHref,
		holdersHref,
		customizationHref,
		biddingHref,
		biddingBasePath,
		biddingQuery = new URLSearchParams(),
		active,
		showCustomization = true,
		showBidding = true
	}: {
		tokensHref: string;
		tokensBasePath: string;
		tokensQuery?: URLSearchParams;
		activitiesHref: string;
		holdersHref: string;
		customizationHref: string;
		biddingHref: string;
		biddingBasePath: string;
		biddingQuery?: URLSearchParams;
		active: 'tokens' | 'activities' | 'holders' | 'customization' | 'bidding' | null;
		showCustomization?: boolean;
		showBidding?: boolean;
	} = $props();

	let resolvedTokensHref = $state(tokensHref);
	let resolvedBiddingHref = $state(biddingHref);

	$effect(() => {
		resolvedTokensHref = preferredCollectionTokensHref({
			basePath: tokensBasePath,
			query: tokensQuery
		});
	});

	$effect(() => {
		resolvedBiddingHref = preferredCollectionBiddingHref({
			basePath: biddingBasePath,
			query: biddingQuery
		});
	});
</script>

<div class="runtime-tabs" aria-label="Collection sections">
	{#if active === 'tokens'}
		<span class="runtime-tab-active">tokens</span>
	{:else}
		<a href={resolvedTokensHref}>tokens</a>
	{/if}
	{#if active === 'activities'}
		<span class="runtime-tab-active">activities</span>
	{:else}
		<a href={activitiesHref}>activities</a>
	{/if}
	{#if active === 'holders'}
		<span class="runtime-tab-active">holders</span>
	{:else}
		<a href={holdersHref}>holders</a>
	{/if}
	{#if showCustomization}
		{#if active === 'customization'}
			<span class="runtime-tab-active">customization</span>
		{:else}
			<a href={customizationHref}>customization</a>
		{/if}
	{/if}
	{#if showBidding}
		{#if active === 'bidding'}
			<span class="runtime-tab-active">bidding</span>
		{:else}
			<a href={resolvedBiddingHref}>bidding</a>
		{/if}
	{/if}
</div>
