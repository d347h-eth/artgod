<script lang="ts">
	import CollectionBiddingView from '$lib/components/CollectionBiddingView.svelte';
	import type {
		ApiBiddingBidBook,
		ApiBiddingPriceTier,
		ApiBiddingTokenOfferCardsPage,
		ApiBiddingJob,
		ApiChain,
		ApiCollection,
		ApiCollectionBiddingBidScopeFilter,
		ApiCollectionBiddingTraitFilterJoinMode,
		ApiCollectionMediaState,
		ApiTokenPresentationSummary,
		ApiTokenAttribute,
		ApiTraitFacet,
		ApiTraitRangeFilter
	} from '$lib/api-types';
	import { emptyBiddingTokenOfferCardsPage } from '$lib/bidding-empty-state';
	import type { CollectionBiddingViewMode } from '$lib/bidding-query';

	type PageData = {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		jobs: ApiBiddingJob[];
		priceTiers: ApiBiddingPriceTier[];
		bidBook: ApiBiddingBidBook;
		tokenOfferCards: ApiBiddingTokenOfferCardsPage;
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
		traitJoinMode: ApiCollectionBiddingTraitFilterJoinMode;
		biddingView: CollectionBiddingViewMode;
		showMuted: boolean;
		makerFilter: string | null;
		mediaMode: string | null;
		requestCursor: string | null;
	};

	let { data }: { data?: PageData } = $props();

	function emptyBidBook(): ApiBiddingBidBook {
		return {
			state: {
				source: 'orders',
				updatedAt: null,
				snapshotRefreshedAtMs: null,
				projectedAt: null,
				rowCount: 0,
				durationMs: null,
				lastError: null
			},
			ownMakerAddress: null,
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
	priceTiers={data?.priceTiers ?? []}
	bidBook={data?.bidBook ?? emptyBidBook()}
	tokenOfferCards={data?.tokenOfferCards ?? emptyBiddingTokenOfferCardsPage()}
	facets={data?.facets ?? []}
	media={data?.media ?? defaultMedia()}
	included={data?.included ?? { tokensById: {}, hasTraitSummaryTemplate: false }}
	basePath={data?.basePath ?? '/'}
	selectedTraits={data?.selectedTraits ?? []}
	selectedTraitRanges={data?.selectedTraitRanges ?? []}
	bidScope={data?.bidScope ?? 'token'}
	traitJoinMode={data?.traitJoinMode ?? 'or'}
	biddingView={data?.biddingView ?? 'bid_book'}
	showMuted={data?.showMuted ?? false}
	makerFilter={data?.makerFilter ?? null}
	mediaMode={data?.mediaMode ?? null}
	requestCursor={data?.requestCursor ?? null}
/>
