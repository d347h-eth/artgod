<script lang="ts">
	import type { ActivityFeedFilterKind } from '@artgod/shared/types';
	import { COLLECTION_ACTIVITY_FILTER_KINDS } from '$lib/activity-query';
	import type { ApiActivityExtensionEventRef } from '$lib/api-types';
	import {
		COLLECTION_BIDDING_VIEW_MODE,
		type CollectionBiddingViewMode
	} from '$lib/bidding-query';
	import {
		collectionExtensionNavigationTabActivityEvent,
		resolveCollectionExtensionNavigationGroups,
		type CollectionExtensionNavigationTab
	} from '$lib/collection-extension-navigation';
	import type { CollectionNavigation } from '$lib/collection-navigation';
	import type { CollectionTokenStatus } from '$lib/token-browser-query';

	let {
		navigation,
		active,
		activeTokenStatus = null,
		activeActivityKind = null,
		activeActivityExtensionEvent = null,
		activeBiddingView = null,
		showCustomization = true
	}: {
		navigation: CollectionNavigation;
		active: 'tokens' | 'activities' | 'holders' | 'customization' | 'bidding' | null;
		activeTokenStatus?: CollectionTokenStatus | null;
		activeActivityKind?: ActivityFeedFilterKind | null;
		activeActivityExtensionEvent?: ApiActivityExtensionEventRef | null;
		activeBiddingView?: CollectionBiddingViewMode | null;
		showCustomization?: boolean;
	} = $props();

	function tokenStatusHref(tokenStatus: CollectionTokenStatus): string {
		return navigation.hrefs.tokenStatus(tokenStatus);
	}

	function activityKindHref(kind: ActivityFeedFilterKind): string {
		return navigation.hrefs.activityKind(kind);
	}

	function activityExtensionEventHref(event: ApiActivityExtensionEventRef): string {
		return navigation.hrefs.activityExtensionEvent(event);
	}

	function biddingViewHref(view: CollectionBiddingViewMode): string {
		return navigation.hrefs.biddingView(view) ?? '#';
	}

	// Core tab group labels stay generic while extension feeds may provide their own group.
	const COLLECTION_SECTION_TAB_GROUP_LABELS = {
		Explore: 'explore',
		AssetEvents: 'asset events'
	} as const;

	let extensionNavigationGroups = $derived(
		resolveCollectionExtensionNavigationGroups({
			activityEventFeeds: navigation.activityEventFeeds
		})
	);

	function extensionNavigationTabHref(tab: CollectionExtensionNavigationTab): string {
		const event = collectionExtensionNavigationTabActivityEvent(tab);
		return event ? activityExtensionEventHref(event) : '#';
	}

	function extensionNavigationTabIsSelected(tab: CollectionExtensionNavigationTab): boolean {
		const event = collectionExtensionNavigationTabActivityEvent(tab);
		if (!event) return false;
		return activityExtensionEventIsSelected(event);
	}

	function activityExtensionEventIsSelected(event: ApiActivityExtensionEventRef): boolean {
		return (
			active === 'activities' &&
			activeActivityExtensionEvent?.extensionKey === event.extensionKey &&
			activeActivityExtensionEvent?.eventKey === event.eventKey
		);
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
		<span class="runtime-tab-group-label">{COLLECTION_SECTION_TAB_GROUP_LABELS.Explore}</span>
		<div class="runtime-tab-group-items">
			{@render navItem('asks', tokenStatusHref('listed'), active === 'tokens' && activeTokenStatus === 'listed')}
			{#if navigation.showBiddingOffers}
				{@render navItem('offers', biddingViewHref(COLLECTION_BIDDING_VIEW_MODE.BidBook), active === 'bidding' && activeBiddingView === COLLECTION_BIDDING_VIEW_MODE.BidBook)}
			{/if}
			{@render navItem('tokens', tokenStatusHref('all'), active === 'tokens' && activeTokenStatus === 'all')}
		</div>
	</div>
	{#if navigation.showBiddingJobs}
		<div class="runtime-tab-standalone">
			{@render navItem('bidding', biddingViewHref(COLLECTION_BIDDING_VIEW_MODE.Jobs), active === 'bidding' && activeBiddingView === COLLECTION_BIDDING_VIEW_MODE.Jobs)}
		</div>
	{/if}
	<div class="runtime-tab-group">
		<span class="runtime-tab-group-label">{COLLECTION_SECTION_TAB_GROUP_LABELS.AssetEvents}</span>
		<div class="runtime-tab-group-items">
			{#each COLLECTION_ACTIVITY_FILTER_KINDS as kind}
				{@render navItem(kind, activityKindHref(kind), active === 'activities' && activeActivityKind === kind)}
			{/each}
		</div>
	</div>
	{#each extensionNavigationGroups as eventFeedGroup}
		<div class="runtime-tab-group">
			<span class="runtime-tab-group-label">{eventFeedGroup.label}</span>
			<div class="runtime-tab-group-items">
				{#each eventFeedGroup.tabs as tab}
					{@render navItem(
						tab.label,
						extensionNavigationTabHref(tab),
						extensionNavigationTabIsSelected(tab)
					)}
				{/each}
			</div>
		</div>
	{/each}
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
