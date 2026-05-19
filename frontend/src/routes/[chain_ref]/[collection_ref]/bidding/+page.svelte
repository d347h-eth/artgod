<script lang="ts">
	import CollectionBiddingView from '$lib/components/CollectionBiddingView.svelte';
	import type {
		ApiBiddingBidBook,
		ApiBiddingCollectionSettings,
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
	import { emptyBiddingBidBook, emptyBiddingTokenOfferCardsPage } from '$lib/bidding-empty-state';
	import { defaultBiddingCollectionSettings } from '$lib/bidding-collection-settings';
	import {
		COLLECTION_BIDDING_BID_SCOPE_FILTER,
		COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
		COLLECTION_BIDDING_VIEW_MODE,
		type CollectionBiddingViewMode
	} from '$lib/bidding-query';

	type PageData = {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		jobs: ApiBiddingJob[];
		biddingSettings: ApiBiddingCollectionSettings;
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
	biddingSettings={data?.biddingSettings ?? defaultBiddingCollectionSettings()}
	priceTiers={data?.priceTiers ?? []}
	bidBook={data?.bidBook ?? emptyBiddingBidBook()}
	tokenOfferCards={data?.tokenOfferCards ?? emptyBiddingTokenOfferCardsPage()}
	facets={data?.facets ?? []}
	media={data?.media ?? defaultMedia()}
	included={data?.included ?? { tokensById: {}, hasTraitSummaryTemplate: false }}
	basePath={data?.basePath ?? '/'}
	selectedTraits={data?.selectedTraits ?? []}
	selectedTraitRanges={data?.selectedTraitRanges ?? []}
	bidScope={data?.bidScope ?? COLLECTION_BIDDING_BID_SCOPE_FILTER.Token}
	traitJoinMode={data?.traitJoinMode ?? COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or}
	biddingView={data?.biddingView ?? COLLECTION_BIDDING_VIEW_MODE.BidBook}
	showMuted={data?.showMuted ?? false}
	makerFilter={data?.makerFilter ?? null}
	mediaMode={data?.mediaMode ?? null}
	requestCursor={data?.requestCursor ?? null}
/>
