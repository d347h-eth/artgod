<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { onMount } from 'svelte';
	import SyncBackfillPageView from '$lib/components/SyncBackfillPageView.svelte';
	import type { SyncBackfillStateApiResponse } from '$lib/api-types';
	import { startSyncBackfillLiveRefresh } from '$lib/sync-backfill-live-refresh';
	import type { SyncBackfillVisibleLevel } from '$lib/sync-backfill-isometric-levels';

	type PageData = {
		state: SyncBackfillStateApiResponse | null;
		levels?: SyncBackfillVisibleLevel[];
		basePath: string;
		collection?: string;
		stack?: string[];
	};

	let { data }: { data?: PageData } = $props();

	onMount(() => {
		if (!data?.state) return;
		const refresh = startSyncBackfillLiveRefresh({ invalidate });
		return refresh.stop;
	});
</script>

<SyncBackfillPageView
	state={data?.state ?? null}
	levels={data?.levels ?? []}
	basePath={data?.basePath ?? '/'}
	collection={data?.collection ?? 'any'}
	stack={data?.stack ?? []}
/>
