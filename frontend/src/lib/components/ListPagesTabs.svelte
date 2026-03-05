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
		<a
			href={collectionsHref}
			class:runtime-tab-active={active === 'collections'}
			aria-current={active === 'collections' ? 'page' : undefined}>collections</a
		>
		<a
			href={bootstrappingHref}
			class:runtime-tab-active={active === 'bootstrapping'}
			aria-current={active === 'bootstrapping' ? 'page' : undefined}>bootstrapping</a
		>
	</div>
</nav>
