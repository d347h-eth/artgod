<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
	import CollectionsPageView from '$lib/components/CollectionsPageView.svelte';
	import type { ApiChain, ApiCollectionsPage } from '$lib/api-types';
	import { desktopRuntimeStore } from '$lib/runtime/desktop-runtime-store';

	type PageData = {
		chain: ApiChain | null;
		page: ApiCollectionsPage;
		status: string;
		basePath: string;
		deferred: boolean;
	};

	let { data }: { data?: PageData } = $props();

	const fallbackPage: ApiCollectionsPage = {
		items: [],
		nextCursor: null,
		limit: DEFAULT_PAGE_LIMIT
	};

	onMount(() => {
		if (!data?.deferred) {
			return;
		}
		void desktopRuntimeStore
			.waitUntilReady()
			.then(() => invalidateAll())
			.catch(() => {});
	});
</script>

<CollectionsPageView
	chain={data?.chain ?? null}
	page={data?.page ?? fallbackPage}
	status={data?.status ?? ''}
	basePath={data?.basePath ?? '/'}
/>
