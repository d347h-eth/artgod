	<script lang="ts">
		import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
		import { COLLECTION_MEDIA_MODE_OPTIONS, COLLECTION_MEDIA_MODES } from '@artgod/shared/extensions';
		import type { BiddingBidBookLiveRefreshConfig } from '@artgod/shared/config/bidding';
		import type { BlockExplorerConfig } from '@artgod/shared/config/block-explorer';
		import CollectionDetailView from '$lib/components/CollectionDetailView.svelte';
	import type {
		ApiChain,
		ApiCollection,
		ApiCollectionMediaState,
		ApiBiddingCollectionSettings,
		ApiBiddingPriceTier,
		ApiTokenAttribute,
		ApiTraitRangeFilter,
		ApiTokensPage,
		ApiTraitFacet
	} from '$lib/api-types';
	import { defaultBiddingCollectionSettings } from '$lib/bidding-collection-settings';

	type PageData = {
		chain: ApiChain;
		collection: ApiCollection;
		media: ApiCollectionMediaState;
		tokens: ApiTokensPage;
		facets: ApiTraitFacet[];
		selectedTraits: ApiTokenAttribute[];
		selectedTraitRanges: ApiTraitRangeFilter[];
		basePath: string;
		requestCursor: string | null;
		tokenStatus: 'listed' | 'all';
		displayMode: 'grid' | 'table';
			biddingSettings: ApiBiddingCollectionSettings;
			priceTiers: ApiBiddingPriceTier[];
			trustOpenSeaSignedZoneTraitOffers?: boolean;
			bidBookLiveRefreshConfig?: BiddingBidBookLiveRefreshConfig;
			blockExplorer?: BlockExplorerConfig;
		};

	let { data }: { data?: PageData } = $props();

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
</script>

<CollectionDetailView
	chain={data?.chain ?? null}
	collection={data?.collection ?? null}
	media={
		data?.media ?? {
			selectedMode: COLLECTION_MEDIA_MODES.Snapshot,
			defaultMode: COLLECTION_MEDIA_MODES.Snapshot,
			availableModes: [
				COLLECTION_MEDIA_MODE_OPTIONS.Snapshot
			],
			preference: null
		}
	}
	tokens={data?.tokens ?? fallbackTokens}
	facets={data?.facets ?? []}
	selectedTraits={data?.selectedTraits ?? []}
	selectedTraitRanges={data?.selectedTraitRanges ?? []}
	basePath={data?.basePath ?? '/'}
	requestCursor={data?.requestCursor ?? null}
	tokenStatus={data?.tokenStatus ?? 'listed'}
	displayMode={data?.displayMode ?? 'grid'}
	biddingSettings={data?.biddingSettings ?? defaultBiddingCollectionSettings()}
		priceTiers={data?.priceTiers ?? []}
		trustOpenSeaSignedZoneTraitOffers={data?.trustOpenSeaSignedZoneTraitOffers}
		bidBookLiveRefreshConfig={data?.bidBookLiveRefreshConfig}
		blockExplorer={data?.blockExplorer}
	/>
