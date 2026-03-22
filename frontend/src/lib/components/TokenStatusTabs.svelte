<script lang="ts">
	import type { ApiTokenAttribute } from '$lib/api-types';
	import { buildTokenBrowserHref } from '$lib/token-browser-query';

	let {
		basePath,
		limit,
		displayMode,
		tokenStatus,
		selectedTraits
	}: {
		basePath: string;
		limit: number;
		displayMode: 'grid' | 'table';
		tokenStatus: 'listed' | 'all';
		selectedTraits: ApiTokenAttribute[];
	} = $props();

	function tokenStatusHref(nextTokenStatus: 'listed' | 'all'): string {
		return buildTokenBrowserHref({
			basePath,
			limit,
			displayMode,
			tokenStatus: nextTokenStatus,
			selectedTraits
		});
	}
</script>

<div class="secondary-tabs" aria-label="Token status filters">
	{#if tokenStatus === 'listed'}
		<span class="secondary-tab-active">only listed</span>
	{:else}
		<a href={tokenStatusHref('listed')}>only listed</a>
	{/if}
	{#if tokenStatus === 'all'}
		<span class="secondary-tab-active">show all</span>
	{:else}
		<a href={tokenStatusHref('all')}>show all</a>
	{/if}
</div>
