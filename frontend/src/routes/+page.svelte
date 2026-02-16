<script lang="ts">
	import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
	import CollectionsPageView from '$lib/components/CollectionsPageView.svelte';
	import type { ApiChain, ApiCollectionsPage } from '$lib/api-types';

	type PageData = {
		chain: ApiChain;
		page: ApiCollectionsPage;
		status: string;
		basePath: string;
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
/>
