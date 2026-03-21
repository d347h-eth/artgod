<script lang="ts">
	import type {
		ApiChain,
		ApiCollection,
		ApiTokenAttribute,
		ApiTokensPage,
		ApiTraitFacet
	} from '$lib/api-types';
	import CollectionSectionTabs from '$lib/components/CollectionSectionTabs.svelte';
	import TokenBrowserView from '$lib/components/TokenBrowserView.svelte';

	let {
		chain,
		collection,
		tokens,
		facets,
		selectedTraits,
		collectionBasePath,
		holdersBasePath,
		browserBasePath,
		owner,
		requestCursor,
		displayMode
	}: {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		tokens: ApiTokensPage;
		facets: ApiTraitFacet[];
		selectedTraits: ApiTokenAttribute[];
		collectionBasePath: string;
		holdersBasePath: string;
		browserBasePath: string;
		owner: string;
		requestCursor: string | null;
		displayMode: 'grid' | 'table';
	} = $props();

	function collectionsHref(): string {
		if (!chain) return '/';
		return `/${chain.slug}`;
	}
</script>

<section class="panel">
	<nav class="breadcrumbs" aria-label="Breadcrumb">
		<a href={collectionsHref()}>collections</a>
		{#if collection}
			<span class="breadcrumbs-separator">/</span>
			<a href={collectionBasePath}>{collection.slug}</a>
			<span class="breadcrumbs-separator">/</span>
			<a href={holdersBasePath}>holders</a>
			<span class="breadcrumbs-separator">/</span>
			<span class="breadcrumbs-current">{owner}</span>
		{/if}
	</nav>

	<header class="panel-header">
		{#if collection}
			<CollectionSectionTabs basePath={collectionBasePath} active="holders" />
		{:else}
			<span class="muted">collection not found</span>
		{/if}
	</header>

	<section class="panel-header">
		<p class="muted">tokens currently held by <span class="mono">{owner}</span></p>
	</section>

	<TokenBrowserView
		chain={chain}
		collection={collection}
		tokens={tokens}
		facets={facets}
		selectedTraits={selectedTraits}
		collectionBasePath={collectionBasePath}
		browserBasePath={browserBasePath}
		requestCursor={requestCursor}
		tokenStatus="listed_then_unlisted"
		displayMode={displayMode}
		showTokenStatusControls={false}
	/>
</section>
