<script lang="ts">
	import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
	import BootstrapRunsPageView from '$lib/components/BootstrapRunsPageView.svelte';
	import type {
		ApiChain,
		ApiOpenSeaIntegrationStatus,
		BootstrapRunsApiResponse
	} from '$lib/api-types';

	type PageData = {
		chain: ApiChain | null;
		page: BootstrapRunsApiResponse['page'];
		status: string;
		basePath: string;
		openseaIntegration: ApiOpenSeaIntegrationStatus | null;
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
	openseaIntegration={data?.openseaIntegration ?? null}
/>
