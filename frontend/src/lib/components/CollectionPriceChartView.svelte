<script lang="ts">
	import type { ApiChain, ApiCollection, ApiCollectionMediaState } from '$lib/api-types';
	import type { BlockExplorerConfig } from '@artgod/shared/config/block-explorer';
	import { buildCollectionNavigation } from '$lib/collection-navigation';
	import { IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT } from '$lib/runtime/public-deployment';
	import CollectionPageLayout from './CollectionPageLayout.svelte';
	import RealizedPriceChart from './RealizedPriceChart.svelte';
	let {
		chain,
		collection,
		media,
		basePath,
		blockExplorer
	}: {
		chain: ApiChain;
		collection: ApiCollection;
		media: ApiCollectionMediaState;
		basePath: string;
		blockExplorer: BlockExplorerConfig;
	} = $props();
	const navigation = $derived(
		buildCollectionNavigation({
			basePath,
			selectedTraits: [],
			selectedTraitRanges: [],
			mediaMode: media.selectedMode,
			mediaPreference: media.preference,
			collectionExtensions: collection.extensions,
			activityEventFeeds: collection.activityEventFeeds
		})
	);
</script>

<CollectionPageLayout {navigation} activeSection="chart" showCustomization={!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}>
	{#snippet breadcrumbs()}
		{#if !IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}<a href={'/' + chain.slug}>collections</a><span class="breadcrumbs-separator">/</span>{/if}
		<a href={basePath}>{collection.slug}</a>
	{/snippet}
	<RealizedPriceChart {chain} {collection} {media} {basePath} {blockExplorer} />
</CollectionPageLayout>
