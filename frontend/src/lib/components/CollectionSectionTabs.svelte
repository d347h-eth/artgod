<script lang="ts">
	import type { ActivityFeedFilterKind } from '@artgod/shared/types';
	import { COLLECTION_ACTIVITY_FILTER_KINDS } from '$lib/activity-query';
	import type { CollectionBiddingViewMode } from '$lib/bidding-query';
	import type { CollectionNavigation } from '$lib/collection-navigation';
	import type { CollectionTokenStatus } from '$lib/token-browser-query';

	let {
		navigation,
		active,
		activeTokenStatus = null,
		activeActivityKind = null,
		activeBiddingView = null,
		showCustomization = true
	}: {
		navigation: CollectionNavigation;
		active: 'tokens' | 'activities' | 'holders' | 'customization' | 'bidding' | null;
		activeTokenStatus?: CollectionTokenStatus | null;
		activeActivityKind?: ActivityFeedFilterKind | null;
		activeBiddingView?: CollectionBiddingViewMode | null;
		showCustomization?: boolean;
	} = $props();

	function tokenStatusHref(tokenStatus: CollectionTokenStatus): string {
		return navigation.hrefs.tokenStatus(tokenStatus);
	}

	function activityKindHref(kind: ActivityFeedFilterKind): string {
		return navigation.hrefs.activityKind(kind);
	}

	function biddingViewHref(view: CollectionBiddingViewMode): string {
		return navigation.hrefs.biddingView(view) ?? '#';
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
			{#if navigation.showBidding}
				{@render navItem('offers', biddingViewHref('bid_book'), active === 'bidding' && activeBiddingView === 'bid_book')}
			{/if}
			{@render navItem('tokens', tokenStatusHref('all'), active === 'tokens' && activeTokenStatus === 'all')}
		</div>
	</div>
	{#if navigation.showBidding}
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
		<a href={navigation.hrefs.holders}>holders</a>
	{/if}
	{#if showCustomization}
		{#if active === 'customization'}
			<span class="runtime-tab-active">customization</span>
		{:else}
			<a href={navigation.hrefs.customization}>customization</a>
		{/if}
	{/if}
</div>
