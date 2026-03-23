<script lang="ts">
	let {
		chainSlug,
		active = null
	}: {
		chainSlug: string | null;
		active?: 'collections' | 'bootstrapping' | null;
	} = $props();

	let collectionsHref = $derived(chainSlug ? `/${chainSlug}` : '/');
	let bootstrappingHref = $derived(chainSlug ? `/${chainSlug}/bootstrap-runs` : '#');
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
	</div>
</nav>
