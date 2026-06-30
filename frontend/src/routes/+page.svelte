<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
	import { defaultBiddingCollectionSettings } from '$lib/bidding-collection-settings';
	import CollectionDetailView from '$lib/components/CollectionDetailView.svelte';
	import CollectionsPageView from '$lib/components/CollectionsPageView.svelte';
	import type {
		ApiChain,
		ApiCollection,
		ApiCollectionMediaState,
		ApiCollectionsPage,
		ApiTokenAttribute,
		ApiTraitFacet,
		ApiTraitRangeFilter,
		ApiTokensPage
	} from '$lib/api-types';
	import { desktopRuntimeStore } from '$lib/runtime/desktop-runtime-store';

	type CollectionsPageData = {
		mode: 'collections';
		chain: ApiChain | null;
		page: ApiCollectionsPage;
		status: string;
		basePath: string;
		deferred: boolean;
	};

	type PublicCollectionPageData = {
		mode: 'public_collection';
		chain: ApiChain | null;
		collection: ApiCollection | null;
		media: ApiCollectionMediaState;
		tokens: ApiTokensPage;
		facets: ApiTraitFacet[];
		selectedTraits: ApiTokenAttribute[];
		selectedTraitRanges: ApiTraitRangeFilter[];
		basePath: string;
		requestCursor: string | null;
		tokenStatus: 'listed' | 'all';
		displayMode: 'grid' | 'table';
	};

	type PageData = CollectionsPageData | PublicCollectionPageData;

	let { data }: { data?: PageData } = $props();

	const fallbackPage: ApiCollectionsPage = {
		items: [],
		nextCursor: null,
		limit: DEFAULT_PAGE_LIMIT
	};

	const fallbackTokens: ApiTokensPage = {
		items: [],
		prevCursor: null,
		nextCursor: null,
		limit: DEFAULT_PAGE_LIMIT,
		totalItems: 0,
		marketplaceBiddingSupportedTotalItems: 0,
		rangeStart: 0,
		rangeEnd: 0,
		currentPage: 0,
		totalPages: 0
	};

	onMount(() => {
		if (data?.mode !== 'collections' || !data.deferred) {
			return;
		}
		void desktopRuntimeStore
			.waitUntilReady()
			.then(() => invalidateAll())
			.catch(() => {});
	});
</script>

{#if data?.mode === 'public_collection'}
	<CollectionDetailView
		chain={data.chain ?? null}
		collection={data.collection ?? null}
		media={
			data.media ?? {
				selectedMode: 'snapshot',
				defaultMode: 'snapshot',
				availableModes: [{ key: 'snapshot', label: 'snapshot' }]
			}
		}
		tokens={data.tokens ?? fallbackTokens}
		facets={data.facets ?? []}
		selectedTraits={data.selectedTraits ?? []}
		selectedTraitRanges={data.selectedTraitRanges ?? []}
		basePath={data.basePath ?? '/'}
		requestCursor={data.requestCursor ?? null}
		tokenStatus={data.tokenStatus ?? 'listed'}
		displayMode={data.displayMode ?? 'grid'}
		biddingSettings={defaultBiddingCollectionSettings()}
	/>
{:else}
	<CollectionsPageView
		chain={data?.chain ?? null}
		page={data?.page ?? fallbackPage}
		status={data?.status ?? ''}
		basePath={data?.basePath ?? '/'}
	/>
{/if}
