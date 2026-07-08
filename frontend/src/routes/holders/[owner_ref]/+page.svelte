	<script lang="ts">
		import type { BlockExplorerConfig } from '@artgod/shared/config/block-explorer';
		import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
	import { defaultBiddingCollectionSettings } from '$lib/bidding-collection-settings';
	import HolderTokensView from '$lib/components/HolderTokensView.svelte';
	import type {
		ApiBiddingCollectionSettings,
		ApiBiddingPriceTier,
		ApiChain,
		ApiCollection,
		ApiCollectionMediaState,
		ApiTokenAttribute,
		ApiTraitRangeFilter,
		ApiTokensPage,
		ApiTraitFacet
	} from '$lib/api-types';

	type PageData = {
		chain: ApiChain;
		collection: ApiCollection;
		media: ApiCollectionMediaState;
		tokens: ApiTokensPage;
		facets: ApiTraitFacet[];
		selectedTraits: ApiTokenAttribute[];
		selectedTraitRanges: ApiTraitRangeFilter[];
		collectionBasePath: string;
		holdersBasePath: string;
		browserBasePath: string;
		owner: string;
		requestCursor: string | null;
			displayMode: 'grid' | 'table';
			biddingSettings?: ApiBiddingCollectionSettings;
			priceTiers?: ApiBiddingPriceTier[];
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

<HolderTokensView
	chain={data?.chain ?? null}
	collection={data?.collection ?? null}
	media={
		data?.media ?? {
			selectedMode: 'snapshot',
			defaultMode: 'snapshot',
			availableModes: [{ key: 'snapshot', label: 'snapshot' }]
		}
	}
	tokens={data?.tokens ?? fallbackTokens}
	facets={data?.facets ?? []}
	selectedTraits={data?.selectedTraits ?? []}
	selectedTraitRanges={data?.selectedTraitRanges ?? []}
	collectionBasePath={data?.collectionBasePath ?? '/'}
	holdersBasePath={data?.holdersBasePath ?? '/'}
	browserBasePath={data?.browserBasePath ?? '/'}
	owner={data?.owner ?? ''}
	requestCursor={data?.requestCursor ?? null}
		displayMode={data?.displayMode ?? 'grid'}
		biddingSettings={data?.biddingSettings ?? defaultBiddingCollectionSettings()}
		priceTiers={data?.priceTiers ?? []}
		blockExplorer={data?.blockExplorer}
	/>
