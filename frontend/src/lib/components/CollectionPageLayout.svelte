<script lang="ts">
	import type { ActivityFeedFilterKind } from '@artgod/shared/types';
	import type { Snippet } from 'svelte';
	import type { CollectionBiddingViewMode } from '$lib/bidding-query';
	import type { CollectionNavigation } from '$lib/collection-navigation';
	import CollectionSectionTabs from '$lib/components/CollectionSectionTabs.svelte';
	import type { CollectionTokenStatus } from '$lib/token-browser-query';

	let {
		navigation,
		activeSection,
		activeTokenStatus = null,
		activeActivityKind = null,
		activeBiddingView = null,
		collectionAvailable = true,
		showCustomization = true,
		breadcrumbs,
		headerActions,
		topActions,
		children
	}: {
		navigation: CollectionNavigation;
		activeSection: 'tokens' | 'activities' | 'holders' | 'customization' | 'bidding' | null;
		activeTokenStatus?: CollectionTokenStatus | null;
		activeActivityKind?: ActivityFeedFilterKind | null;
		activeBiddingView?: CollectionBiddingViewMode | null;
		collectionAvailable?: boolean;
		showCustomization?: boolean;
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
					{navigation}
					active={activeSection}
					{activeTokenStatus}
					{activeActivityKind}
					{activeBiddingView}
					{showCustomization}
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
