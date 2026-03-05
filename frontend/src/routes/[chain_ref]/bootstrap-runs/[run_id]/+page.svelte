<script lang="ts">
	import BootstrapRunDetailView from '$lib/components/BootstrapRunDetailView.svelte';
	import type { BootstrapRunDetailApiResponse } from '$lib/api-types';

	type PageData = {
		chainRef: string;
		runId: number;
		initialDetail: BootstrapRunDetailApiResponse | null;
	};

	let { data }: { data?: PageData } = $props();
</script>

<BootstrapRunDetailView
	chainRef={data?.chainRef ?? ''}
	runId={data?.runId ?? null}
	initialDetail={data?.initialDetail ?? null}
/>
