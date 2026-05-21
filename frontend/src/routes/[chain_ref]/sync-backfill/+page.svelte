<script lang="ts">
	import SyncBackfillPageView from '$lib/components/SyncBackfillPageView.svelte';
	import type { SyncBackfillStateApiResponse } from '$lib/api-types';
	import type { SyncBackfillVisibleLevel } from '$lib/sync-backfill-isometric-levels';

	type PageData = {
		state: SyncBackfillStateApiResponse | null;
		levels?: SyncBackfillVisibleLevel[];
		basePath: string;
		collection?: string;
		stack?: string[];
	};

	let { data }: { data?: PageData } = $props();
</script>

<SyncBackfillPageView
	state={data?.state ?? null}
	levels={data?.levels ?? []}
	basePath={data?.basePath ?? '/'}
	collection={data?.collection ?? 'any'}
	stack={data?.stack ?? []}
/>
