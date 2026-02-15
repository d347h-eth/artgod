<script lang="ts">
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
		limit: 25
	};
</script>

<CollectionsPageView
	chain={data?.chain ?? null}
	page={data?.page ?? fallbackPage}
	status={data?.status ?? ''}
	basePath={data?.basePath ?? '/'}
/>
