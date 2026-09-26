<script lang="ts">
	import type {
		ApiChain,
		ApiCollection,
		ApiCollectionMediaState,
		ApiTraitFacet,
		ApiTokenAttribute,
		ApiTraitRangeFilter
	} from '$lib/api-types';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import type { BlockExplorerConfig } from '@artgod/shared/config/block-explorer';
	import { buildCollectionNavigation } from '$lib/collection-navigation';
	import { IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT } from '$lib/runtime/public-deployment';
	import CollectionPageLayout from './CollectionPageLayout.svelte';
	import RealizedPriceChart from './RealizedPriceChart.svelte';
	import TraitFacetPanel from './TraitFacetPanel.svelte';
	import TraitFacetPanelControls from './TraitFacetPanelControls.svelte';
	import { createTraitFacetPanelController } from './trait-facet-panel-controller';
	import { nextSelectedTraits, setTraitRangeFilter } from '$lib/trait-filters';
	import { buildCollectionChartFiltersHref } from '$lib/price-chart/routing';
	let {
		chain,
		collection,
		media,
		facets,
		selectedTraits,
		selectedTraitRanges,
		basePath,
		blockExplorer
	}: {
		chain: ApiChain;
		collection: ApiCollection;
		media: ApiCollectionMediaState;
		facets: ApiTraitFacet[];
		selectedTraits: ApiTokenAttribute[];
		selectedTraitRanges: ApiTraitRangeFilter[];
		basePath: string;
		blockExplorer: BlockExplorerConfig;
	} = $props();
	const traitFacetPanel = createTraitFacetPanelController();
	const traitFacetPanelState = traitFacetPanel.state;
	const navigation = $derived(
		buildCollectionNavigation({
			basePath,
			selectedTraits,
			selectedTraitRanges,
			mediaMode: media.selectedMode,
			mediaPreference: media.preference,
			collectionExtensions: collection.extensions,
			activityEventFeeds: collection.activityEventFeeds
		})
	);
	async function applyTraitFilters(traits: ApiTokenAttribute[], ranges: ApiTraitRangeFilter[]) {
		await goto(buildCollectionChartFiltersHref(page.url, traits, ranges), {
			invalidateAll: true,
			keepFocus: true,
			noScroll: true
		});
	}
	const resetTraits = () => applyTraitFilters([], []);
	function toggleTrait(key: string, value: string, checked: boolean, exclusiveMode: boolean) {
		return applyTraitFilters(
			nextSelectedTraits(selectedTraits, key, value, checked, exclusiveMode),
			selectedTraitRanges
		);
	}
	function applyRange(key: string, fromValue: string | null, toValue: string | null) {
		return applyTraitFilters(
			selectedTraits,
			setTraitRangeFilter(selectedTraitRanges, key, fromValue, toValue)
		);
	}
</script>

<svelte:window onkeydown={(event) => traitFacetPanel.onWindowKeydown(event, { onReset: resetTraits })} />

<CollectionPageLayout {navigation} activeSection="chart" showCustomization={!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}>
	{#snippet breadcrumbs()}
		{#if !IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}<a href={'/' + chain.slug}>collections</a><span class="breadcrumbs-separator">/</span>{/if}
		<a href={basePath}>{collection.slug}</a>
	{/snippet}
	{#snippet topActions()}
		<div class="panel-top-actions-row">
			<TraitFacetPanelControls
				hasActiveFilters={selectedTraits.length > 0 || selectedTraitRanges.length > 0}
				collapsed={$traitFacetPanelState.collapsed}
				onToggleCollapsed={traitFacetPanel.toggle}
				onReset={resetTraits}
				{selectedTraits}
				selectedRanges={selectedTraitRanges}
				onSelectedFiltersChange={applyTraitFilters}
			/>
		</div>
	{/snippet}
	<div class="detail-layout" class:sidebar-collapsed={$traitFacetPanelState.collapsed}>
		<TraitFacetPanel
			{facets}
			{selectedTraits}
			selectedRanges={selectedTraitRanges}
			collapsed={$traitFacetPanelState.collapsed}
			onToggleTrait={toggleTrait}
			onApplyTraitRange={applyRange}
		/>
		<RealizedPriceChart {chain} {collection} {media} {basePath} {blockExplorer} {selectedTraits} {selectedTraitRanges} />
	</div>
</CollectionPageLayout>
