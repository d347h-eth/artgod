	<script lang="ts">
		import type { BlockExplorerConfig } from '@artgod/shared/config/block-explorer';
		import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
	import CollectionHoldersView from '$lib/components/CollectionHoldersView.svelte';
	import type {
		ApiChain,
		ApiCollection,
		ApiCollectionHoldersPage
	} from '$lib/api-types';

	type PageData = {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		holders: ApiCollectionHoldersPage;
			basePath: string;
			selectedMediaMode: string | null;
			requestCursor: string | null;
			blockExplorer?: BlockExplorerConfig;
		};

	const fallbackHolders: ApiCollectionHoldersPage = {
		items: [],
		nextCursor: null,
		limit: DEFAULT_PAGE_LIMIT,
		totalItems: 0,
		rangeStart: 0,
		rangeEnd: 0,
		currentPage: 0,
		totalPages: 0
	};

	let { data }: { data?: PageData } = $props();
</script>

<CollectionHoldersView
	chain={data?.chain ?? null}
	collection={data?.collection ?? null}
	holders={data?.holders ?? fallbackHolders}
		basePath={data?.basePath ?? '/'}
		selectedMediaMode={data?.selectedMediaMode ?? null}
		requestCursor={data?.requestCursor ?? null}
		blockExplorer={data?.blockExplorer}
	/>
