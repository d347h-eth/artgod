<script lang="ts">
	import BlockspacePageView from '$lib/components/BlockspacePageView.svelte';
	import type { BlockspaceStateApiResponse } from '$lib/api-types';
	import type { BlockspaceVisibleLevel } from '$lib/blockspace-isometric-levels';

	type PageData = {
		state: BlockspaceStateApiResponse | null;
		levels?: BlockspaceVisibleLevel[];
		basePath: string;
		collection?: string;
		stack?: string[];
	};

	let { data }: { data?: PageData } = $props();
</script>

<BlockspacePageView
	state={data?.state ?? null}
	levels={data?.levels ?? []}
	basePath={data?.basePath ?? '/'}
	collection={data?.collection ?? 'any'}
	stack={data?.stack ?? []}
/>
