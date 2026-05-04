<script lang="ts">
	import type { ActivityFeedFilterKind } from '@artgod/shared/types';
	import { COLLECTION_ACTIVITY_FILTER_KINDS } from '$lib/activity-query';
	import type { CollectionBiddingViewMode } from '$lib/bidding-query';
	import {
		collectionActivityKindHref,
		collectionBiddingViewHref,
		collectionTokenStatusHref,
		type CollectionSectionNavigationConfig
	} from '$lib/components/collection-section-navigation';
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
		active,
		activeTokenStatus = null,
		activeActivityKind = null,
		activeBiddingView = null,
		showCustomization = true,
		showBidding = true
	}: {
		tokensBasePath: string;
		tokensQuery?: URLSearchParams;
		activitiesBasePath: string;
		activitiesQuery?: URLSearchParams;
		holdersHref: string;
		customizationHref: string;
		biddingBasePath: string;
		biddingQuery?: URLSearchParams;
		active: 'tokens' | 'activities' | 'holders' | 'customization' | 'bidding' | null;
		activeTokenStatus?: CollectionTokenStatus | null;
		activeActivityKind?: ActivityFeedFilterKind | null;
		activeBiddingView?: CollectionBiddingViewMode | null;
		showCustomization?: boolean;
		showBidding?: boolean;
	} = $props();

	const navigationConfig = $derived<CollectionSectionNavigationConfig>({
		tokensBasePath,
		tokensQuery,
		activitiesBasePath,
		activitiesQuery,
		biddingBasePath,
		biddingQuery,
		showBidding
	});

	function tokenStatusHref(tokenStatus: CollectionTokenStatus): string {
		return collectionTokenStatusHref(navigationConfig, tokenStatus);
	}

	function activityKindHref(kind: ActivityFeedFilterKind): string {
		return collectionActivityKindHref(navigationConfig, kind);
	}

	function biddingViewHref(view: CollectionBiddingViewMode): string {
		return collectionBiddingViewHref(navigationConfig, view) ?? '#';
	}
</script>

{#snippet navItem(label: string, href: string, selected: boolean)}
	{#if selected}
		<span class="runtime-tab-active">{label}</span>
	{:else}
		<a href={href}>{label}</a>
	{/if}
{/snippet}

<div class="runtime-tabs collection-section-tabs" aria-label="Collection sections">
	<div class="runtime-tab-group">
		<span class="runtime-tab-group-label">explore</span>
		<div class="runtime-tab-group-items">
			{@render navItem('asks', tokenStatusHref('listed'), active === 'tokens' && activeTokenStatus === 'listed')}
			{#if showBidding}
				{@render navItem('offers', biddingViewHref('bid_book'), active === 'bidding' && activeBiddingView === 'bid_book')}
			{/if}
			{@render navItem('tokens', tokenStatusHref('all'), active === 'tokens' && activeTokenStatus === 'all')}
		</div>
	</div>
	{#if showBidding}
		<div class="runtime-tab-standalone">
			{@render navItem('bidding', biddingViewHref('jobs'), active === 'bidding' && activeBiddingView === 'jobs')}
		</div>
	{/if}
	<div class="runtime-tab-group">
		<span class="runtime-tab-group-label">events</span>
		<div class="runtime-tab-group-items">
			{#each COLLECTION_ACTIVITY_FILTER_KINDS as kind}
				{@render navItem(kind, activityKindHref(kind), active === 'activities' && activeActivityKind === kind)}
			{/each}
		</div>
	</div>
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
</div>
