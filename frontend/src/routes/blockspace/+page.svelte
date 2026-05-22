<script lang="ts">
	import { collectionBiddingNavigationVisibilityForDeployment } from '$lib/runtime/public-deployment';
	import { buildCollectionNavigation } from '$lib/collection-navigation';
	import CollectionPageLayout from '$lib/components/CollectionPageLayout.svelte';
	import BlockspacePageView from '$lib/components/BlockspacePageView.svelte';
	import type { ApiCollection, BlockspaceStateApiResponse } from '$lib/api-types';
	import type { BlockspaceVisibleLevel } from '$lib/blockspace-isometric-levels';

	type PageData = {
		state: BlockspaceStateApiResponse | null;
		levels?: BlockspaceVisibleLevel[];
		basePath: string;
		collection: string;
		collectionDetail?: ApiCollection | null;
		stack: string[];
	};

	let { data }: { data?: PageData } = $props();

	function collectionNavigation() {
		return buildCollectionNavigation({
			basePath: '/',
			activityEventFeeds: data?.collectionDetail?.activityEventFeeds ?? [],
			selectedTraits: [],
			selectedTraitRanges: [],
			bidding: {
				...collectionBiddingNavigationVisibilityForDeployment()
			}
		});
	}
</script>

<CollectionPageLayout
	navigation={collectionNavigation()}
	activeSection="blockspace"
	collectionAvailable={data?.state != null}
	showCustomization={false}
>
	{#snippet breadcrumbs()}
		<a href={collectionNavigation().hrefs.asks}>{data?.collection ?? 'collection'}</a>
		<span class="breadcrumbs-separator">/</span>
		<span class="breadcrumbs-current">blockspace</span>
	{/snippet}

	<BlockspacePageView
		state={data?.state ?? null}
		levels={data?.levels ?? []}
		basePath={data?.basePath ?? '/blockspace'}
		collection={data?.collection ?? 'any'}
		stack={data?.stack ?? []}
		showListNavigation={false}
		showContextSelector={false}
		includeCollectionQueryParam={false}
		canCommitBackfill={false}
		showPanelShell={false}
	/>
</CollectionPageLayout>
