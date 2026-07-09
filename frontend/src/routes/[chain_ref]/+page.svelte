<script lang="ts">
	import type { BlockExplorerConfig } from '@artgod/shared/config/block-explorer';
	import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
	import CollectionsPageView from '$lib/components/CollectionsPageView.svelte';
	import type { ApiChain, ApiCollectionsPage, ApiOpenSeaIntegrationStatus } from '$lib/api-types';

	type PageData = {
		chain: ApiChain;
		page: ApiCollectionsPage;
		status: string;
		basePath: string;
		blockExplorer?: BlockExplorerConfig;
		openseaIntegration?: ApiOpenSeaIntegrationStatus | null;
	};

	let { data }: { data?: PageData } = $props();

	const fallbackPage: ApiCollectionsPage = {
		items: [],
		nextCursor: null,
		limit: DEFAULT_PAGE_LIMIT
	};
</script>

<CollectionsPageView
	chain={data?.chain ?? null}
	page={data?.page ?? fallbackPage}
	status={data?.status ?? ''}
	basePath={data?.basePath ?? '/'}
	blockExplorer={data?.blockExplorer}
	openseaIntegration={data?.openseaIntegration ?? null}
/>
