<script lang="ts">
	import CollectionBiddingView from '$lib/components/CollectionBiddingView.svelte';
	import type {
		ApiBiddingBidBook,
		ApiBiddingJob,
		ApiChain,
		ApiCollection,
		ApiCollectionBiddingBidScopeFilter,
		ApiCollectionMediaState,
		ApiTokenPresentationSummary,
		ApiTokenAttribute,
		ApiTraitFacet,
		ApiTraitRangeFilter
	} from '$lib/api-types';
	import type { CollectionBiddingViewMode } from '$lib/bidding-query';

	type PageData = {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		jobs: ApiBiddingJob[];
		bidBook: ApiBiddingBidBook;
		facets: ApiTraitFacet[];
		media: ApiCollectionMediaState;
		included: {
			tokensById: Record<string, ApiTokenPresentationSummary>;
			hasTraitSummaryTemplate: boolean;
		};
		basePath: string;
		selectedTraits: ApiTokenAttribute[];
		selectedTraitRanges: ApiTraitRangeFilter[];
		bidScope: ApiCollectionBiddingBidScopeFilter;
		biddingView: CollectionBiddingViewMode;
		showMuted: boolean;
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

	function defaultMedia(): ApiCollectionMediaState {
		return {
			selectedMode: 'snapshot',
			defaultMode: 'snapshot',
			availableModes: [{ key: 'snapshot', label: 'snapshot' }]
		};
	}
</script>

<CollectionBiddingView
	chain={data?.chain ?? null}
	collection={data?.collection ?? null}
	jobs={data?.jobs ?? []}
	bidBook={data?.bidBook ?? emptyBidBook()}
	facets={data?.facets ?? []}
	media={data?.media ?? defaultMedia()}
	included={data?.included ?? { tokensById: {}, hasTraitSummaryTemplate: false }}
	basePath={data?.basePath ?? '/'}
	selectedTraits={data?.selectedTraits ?? []}
	selectedTraitRanges={data?.selectedTraitRanges ?? []}
	bidScope={data?.bidScope ?? 'collection'}
	biddingView={data?.biddingView ?? 'bid_book'}
	showMuted={data?.showMuted ?? false}
	mediaMode={data?.mediaMode ?? null}
/>
