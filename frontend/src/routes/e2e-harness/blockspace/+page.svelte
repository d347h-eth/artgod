<script lang="ts">
	import BlockspacePageView from '$lib/components/BlockspacePageView.svelte';
	import type { ComponentProps } from 'svelte';

	let { data }: { data: ComponentProps<typeof BlockspacePageView> } = $props();
</script>

<BlockspacePageView {...data} showListNavigation={false} />
