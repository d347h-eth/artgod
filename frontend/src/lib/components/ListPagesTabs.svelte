<script lang="ts">
	let {
		chainSlug,
		active = null
	}: {
		chainSlug: string | null;
		active?: 'collections' | 'bootstrapping' | 'blockspace' | null;
	} = $props();

	let collectionsHref = $derived(chainSlug ? `/${chainSlug}` : '/');
	let bootstrappingHref = $derived(chainSlug ? `/${chainSlug}/bootstrap-runs` : '#');
	let blockspaceHref = $derived(chainSlug ? `/${chainSlug}/blockspace` : '#');
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
		{#if active === 'blockspace'}
			<span class="runtime-tab-active">blockspace</span>
		{:else}
			<a href={blockspaceHref}>blockspace</a>
		{/if}
	</div>
</nav>
