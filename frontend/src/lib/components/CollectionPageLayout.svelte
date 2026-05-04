<script lang="ts">
	import type { ActivityFeedFilterKind } from '@artgod/shared/types';
	import type { Snippet } from 'svelte';
	import type { CollectionBiddingViewMode } from '$lib/bidding-query';
	import CollectionSectionTabs from '$lib/components/CollectionSectionTabs.svelte';
	import type { CollectionTokenStatus } from '$lib/token-browser-query';

	let {
		tokensBasePath,
		tokensQuery = new URLSearchParams(),
		activitiesBasePath,
		activitiesQuery = new URLSearchParams(),
		holdersHref,
		customizationHref,
		biddingBasePath,
		biddingQuery = new URLSearchParams(),
		activeSection,
		activeTokenStatus = null,
		activeActivityKind = null,
		activeBiddingView = null,
		collectionAvailable = true,
		showCustomization = true,
		showBidding = true,
		breadcrumbs,
		headerActions,
		topActions,
		children
	}: {
		tokensBasePath: string;
		tokensQuery?: URLSearchParams;
		activitiesBasePath: string;
		activitiesQuery?: URLSearchParams;
		holdersHref: string;
		customizationHref: string;
		biddingBasePath: string;
		biddingQuery?: URLSearchParams;
		activeSection: 'tokens' | 'activities' | 'holders' | 'customization' | 'bidding' | null;
		activeTokenStatus?: CollectionTokenStatus | null;
		activeActivityKind?: ActivityFeedFilterKind | null;
		activeBiddingView?: CollectionBiddingViewMode | null;
		collectionAvailable?: boolean;
		showCustomization?: boolean;
		showBidding?: boolean;
		breadcrumbs: Snippet;
		headerActions?: Snippet;
		topActions?: Snippet;
		children: Snippet;
	} = $props();
</script>

<section class="panel">
	<nav class="breadcrumbs" aria-label="Breadcrumb">
		{@render breadcrumbs()}
	</nav>

	<header class="panel-header">
		<div class="panel-header-main">
			{#if collectionAvailable}
				<CollectionSectionTabs
					{tokensBasePath}
					{tokensQuery}
					{activitiesBasePath}
					{activitiesQuery}
					{holdersHref}
					{customizationHref}
					{biddingBasePath}
					{biddingQuery}
					active={activeSection}
					{activeTokenStatus}
					{activeActivityKind}
					{activeBiddingView}
					{showCustomization}
					{showBidding}
				/>
			{:else}
				<span class="muted">collection not found</span>
			{/if}
		</div>
		{#if headerActions}
			<div class="panel-header-right">
				{@render headerActions()}
			</div>
		{/if}
	</header>

	{#if topActions}
		<div class="panel-top-actions panel-top-actions-stack">
			{@render topActions()}
		</div>
	{/if}

	{@render children()}
</section>
