<script lang="ts">
	let {
		chainSlug,
		active = null
	}: {
		chainSlug: string | null;
		active?: 'collections' | 'bootstrapping' | 'sync-backfill' | null;
	} = $props();

	let collectionsHref = $derived(chainSlug ? `/${chainSlug}` : '/');
	let bootstrappingHref = $derived(chainSlug ? `/${chainSlug}/bootstrap-runs` : '#');
	let syncBackfillHref = $derived(chainSlug ? `/${chainSlug}/sync-backfill` : '#');
</script>

<nav class="panel-header" aria-label="Collections tabs">
	<div class="runtime-tabs">
		{#if active === 'collections'}
			<span class="runtime-tab-active">collections</span>
		{:else}
			<a href={collectionsHref}>collections</a>
		{/if}
		{#if active === 'bootstrapping'}
			<span class="runtime-tab-active">bootstrapping</span>
		{:else}
			<a href={bootstrappingHref}>bootstrapping</a>
		{/if}
		{#if active === 'sync-backfill'}
			<span class="runtime-tab-active">sync/backfill</span>
		{:else}
			<a href={syncBackfillHref}>sync/backfill</a>
		{/if}
	</div>
</nav>
