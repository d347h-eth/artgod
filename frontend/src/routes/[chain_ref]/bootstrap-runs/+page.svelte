<script lang="ts">
	import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
	import BootstrapRunsPageView from '$lib/components/BootstrapRunsPageView.svelte';
	import type { ApiChain, BootstrapRunsApiResponse } from '$lib/api-types';

	type PageData = {
		chain: ApiChain;
		page: BootstrapRunsApiResponse['page'];
		status: string;
		basePath: string;
	};

	let { data }: { data?: PageData } = $props();

	const fallbackPage: BootstrapRunsApiResponse['page'] = {
		items: [],
		nextCursor: null,
		limit: DEFAULT_PAGE_LIMIT
	};
</script>

<BootstrapRunsPageView
	chain={data?.chain ?? null}
	page={data?.page ?? fallbackPage}
	status={data?.status ?? ''}
	basePath={data?.basePath ?? '/'}
/>
