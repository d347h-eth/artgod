<script lang="ts">
	import { collectionBiddingNavigationVisibilityForDeployment } from '$lib/runtime/public-deployment';
	import { buildCollectionNavigation } from '$lib/collection-navigation';
	import CollectionPageLayout from '$lib/components/CollectionPageLayout.svelte';
	import SyncBackfillPageView from '$lib/components/SyncBackfillPageView.svelte';
	import type { SyncBackfillStateApiResponse } from '$lib/api-types';
	import type { SyncBackfillVisibleLevel } from '$lib/sync-backfill-isometric-levels';

	type PageData = {
		state: SyncBackfillStateApiResponse | null;
		levels?: SyncBackfillVisibleLevel[];
		basePath: string;
		collection: string;
		stack: string[];
	};

	let { data }: { data?: PageData } = $props();

	function collectionNavigation() {
		return buildCollectionNavigation({
			basePath: '/',
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

	<SyncBackfillPageView
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
