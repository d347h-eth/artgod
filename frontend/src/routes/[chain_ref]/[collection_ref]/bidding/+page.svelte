<script lang="ts">
	import CollectionBiddingView from '$lib/components/CollectionBiddingView.svelte';
	import type {
		ApiBiddingBidBook,
		ApiBiddingJob,
		ApiChain,
		ApiCollection,
		ApiCollectionBiddingBidScopeFilter,
		ApiTokenAttribute,
		ApiTraitFacet,
		ApiTraitRangeFilter
	} from '$lib/api-types';

	type PageData = {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		jobs: ApiBiddingJob[];
		bidBook: ApiBiddingBidBook;
		facets: ApiTraitFacet[];
		basePath: string;
		selectedTraits: ApiTokenAttribute[];
		selectedTraitRanges: ApiTraitRangeFilter[];
		bidScope: ApiCollectionBiddingBidScopeFilter;
		mediaMode: string | null;
	};

	let { data }: { data?: PageData } = $props();

	function emptyBidBook(): ApiBiddingBidBook {
		return {
			state: {
				source: 'orders',
				snapshotRefreshedAtMs: null,
				projectedAt: null,
				rowCount: 0,
				durationMs: null,
				lastError: null
			},
			bids: []
		};
	}
</script>

<CollectionBiddingView
	chain={data?.chain ?? null}
	collection={data?.collection ?? null}
	jobs={data?.jobs ?? []}
	bidBook={data?.bidBook ?? emptyBidBook()}
	facets={data?.facets ?? []}
	basePath={data?.basePath ?? '/'}
	selectedTraits={data?.selectedTraits ?? []}
	selectedTraitRanges={data?.selectedTraitRanges ?? []}
	bidScope={data?.bidScope ?? 'collection'}
	mediaMode={data?.mediaMode ?? null}
/>
