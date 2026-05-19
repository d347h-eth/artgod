<script lang="ts">
	import SyncBackfillPageView from '$lib/components/SyncBackfillPageView.svelte';
	import type { SyncBackfillStateApiResponse } from '$lib/api-types';

	type PageData = {
		state: SyncBackfillStateApiResponse | null;
		basePath: string;
		collection?: string;
		stack?: string[];
		generatedAtMs?: number;
	};

	let { data }: { data?: PageData } = $props();
</script>

<SyncBackfillPageView
	state={data?.state ?? null}
	basePath={data?.basePath ?? '/'}
	collection={data?.collection ?? 'any'}
	stack={data?.stack ?? []}
	generatedAtMs={data?.generatedAtMs ?? Date.now()}
/>
