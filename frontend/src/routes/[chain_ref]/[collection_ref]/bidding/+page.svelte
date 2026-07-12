	<script lang="ts">
		import CollectionBiddingView from '$lib/components/CollectionBiddingView.svelte';
		import { COLLECTION_MEDIA_MODE_OPTIONS, COLLECTION_MEDIA_MODES } from '@artgod/shared/extensions';
		import type { BiddingBidBookLiveRefreshConfig } from '@artgod/shared/config/bidding';
		import type { BlockExplorerConfig } from '@artgod/shared/config/block-explorer';
		import type {
		ApiBiddingBidBook,
		ApiBiddingCollectionSettings,
		ApiBiddingPriceTier,
		ApiBiddingTokenOfferCardsPage,
		ApiChain,
		ApiCollection,
		ApiCollectionBiddingBidScopeFilter,
		ApiCollectionBiddingTraitFilterJoinMode,
		ApiCollectionMediaState,
		ApiTokenAttribute,
		ApiTraitFacet,
		ApiTraitRangeFilter
	} from '$lib/api-types';
	import { emptyBiddingBidBook, emptyBiddingTokenOfferCardsPage } from '$lib/bidding-empty-state';
	import { defaultBiddingCollectionSettings } from '$lib/bidding-collection-settings';
	import {
		COLLECTION_BIDDING_BID_SCOPE_FILTER,
		COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE
	} from '$lib/bidding-query';

	type PageData = {
		chain: ApiChain | null;
		collection: ApiCollection | null;
			biddingSettings: ApiBiddingCollectionSettings;
			priceTiers: ApiBiddingPriceTier[];
			trustOpenSeaSignedZoneTraitOffers?: boolean;
			bidBookLiveRefreshConfig?: BiddingBidBookLiveRefreshConfig;
			blockExplorer?: BlockExplorerConfig;
			bidBook: ApiBiddingBidBook;
		tokenOfferCards: ApiBiddingTokenOfferCardsPage;
		facets: ApiTraitFacet[];
		media: ApiCollectionMediaState;
		basePath: string;
		selectedTraits: ApiTokenAttribute[];
		selectedTraitRanges: ApiTraitRangeFilter[];
		bidScope: ApiCollectionBiddingBidScopeFilter;
		traitJoinMode: ApiCollectionBiddingTraitFilterJoinMode;
		showMuted: boolean;
		makerFilter: string | null;
		mediaMode: string | null;
		requestCursor: string | null;
	};

	let { data }: { data?: PageData } = $props();

	function defaultMedia(): ApiCollectionMediaState {
		return {
			selectedMode: COLLECTION_MEDIA_MODES.Snapshot,
			defaultMode: COLLECTION_MEDIA_MODES.Snapshot,
			availableModes: [
				COLLECTION_MEDIA_MODE_OPTIONS.Snapshot
			],
			preference: null
		};
	}
</script>

<CollectionBiddingView
	chain={data?.chain ?? null}
	collection={data?.collection ?? null}
	biddingSettings={data?.biddingSettings ?? defaultBiddingCollectionSettings()}
		priceTiers={data?.priceTiers ?? []}
		trustOpenSeaSignedZoneTraitOffers={data?.trustOpenSeaSignedZoneTraitOffers}
		bidBookLiveRefreshConfig={data?.bidBookLiveRefreshConfig}
		blockExplorer={data?.blockExplorer}
		bidBook={data?.bidBook ?? emptyBiddingBidBook()}
	tokenOfferCards={data?.tokenOfferCards ?? emptyBiddingTokenOfferCardsPage()}
	facets={data?.facets ?? []}
	media={data?.media ?? defaultMedia()}
	basePath={data?.basePath ?? '/'}
	selectedTraits={data?.selectedTraits ?? []}
	selectedTraitRanges={data?.selectedTraitRanges ?? []}
	bidScope={data?.bidScope ?? COLLECTION_BIDDING_BID_SCOPE_FILTER.Token}
	traitJoinMode={data?.traitJoinMode ?? COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or}
	showMuted={data?.showMuted ?? false}
	makerFilter={data?.makerFilter ?? null}
	mediaMode={data?.mediaMode ?? null}
	requestCursor={data?.requestCursor ?? null}
/>
