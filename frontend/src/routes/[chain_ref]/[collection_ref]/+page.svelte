<script lang="ts">
	import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
	import CollectionDetailView from '$lib/components/CollectionDetailView.svelte';
	import type {
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
		basePath: string;
		requestCursor: string | null;
		tokenStatus: 'listed' | 'all';
		displayMode: 'grid' | 'table';
	};

	let { data }: { data?: PageData } = $props();

	const fallbackTokens: ApiTokensPage = {
		items: [],
		prevCursor: null,
		nextCursor: null,
		limit: DEFAULT_PAGE_LIMIT,
		totalItems: 0,
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
			selectedMode: 'snapshot',
			defaultMode: 'snapshot',
			availableModes: [{ key: 'snapshot', label: 'snapshot' }]
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
/>
