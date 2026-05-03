<script lang="ts">
	import type { Snippet } from 'svelte';
	import CollectionSectionTabs from '$lib/components/CollectionSectionTabs.svelte';

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
		activeSection,
		collectionAvailable = true,
		showCustomization = true,
		showBidding = true,
		breadcrumbs,
		headerActions,
		topActions,
		children
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
		activeSection: 'tokens' | 'activities' | 'holders' | 'customization' | 'bidding' | null;
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
					{tokensHref}
					{tokensBasePath}
					{tokensQuery}
					{activitiesHref}
					{holdersHref}
					{customizationHref}
					{biddingHref}
					{biddingBasePath}
					{biddingQuery}
					active={activeSection}
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
