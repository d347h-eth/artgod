<script lang="ts">
	import { goto } from '$app/navigation';
	import type {
		ApiChain,
		ApiCollection,
		ApiTokenAttribute,
		ApiTokensPage,
		ApiTraitFacet
	} from '$lib/api-types';
	import CollectionSectionTabs from '$lib/components/CollectionSectionTabs.svelte';
	import TraitFacetPanelControls from '$lib/components/TraitFacetPanelControls.svelte';
	import TokenBrowserView from '$lib/components/TokenBrowserView.svelte';
	import { createTraitFacetPanelController } from '$lib/components/trait-facet-panel-controller';
	import { buildTokenBrowserHref } from '$lib/token-browser-query';

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

	const traitFacetPanel = createTraitFacetPanelController();
	const traitFacetPanelState = traitFacetPanel.state;

	function collectionsHref(): string {
		if (!chain) return '/';
		return `/${chain.slug}`;
	}

	function resetTraitsHref(): string {
		return buildTokenBrowserHref({
			basePath: browserBasePath,
			limit: tokens.limit,
			displayMode,
			tokenStatus: 'listed_then_unlisted',
			selectedTraits: []
		});
	}

	async function onResetTraits(): Promise<void> {
		await goto(resetTraitsHref(), {
			invalidateAll: true,
			keepFocus: true,
			noScroll: true
		});
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
			<CollectionSectionTabs
				tokensHref={collectionBasePath}
				activitiesHref={`${collectionBasePath}/activity?kind=sales`}
				holdersHref={holdersBasePath}
				active="holders"
			/>
		{:else}
			<span class="muted">collection not found</span>
		{/if}
	</header>

	{#if collection}
		<div class="panel-top-actions panel-top-actions-stack">
			<div class="panel-top-actions-row">
				<p class="muted">tokens currently held by <span class="mono">{owner}</span></p>
			</div>
			<div class="panel-top-actions-row">
				<TraitFacetPanelControls
					hasActiveFilters={selectedTraits.length > 0}
					collapsed={$traitFacetPanelState.collapsed}
					onToggleCollapsed={traitFacetPanel.toggle}
					onReset={onResetTraits}
				/>
			</div>
		</div>
	{/if}

	<TokenBrowserView
		chain={chain}
		collection={collection}
		tokens={tokens}
		facets={facets}
		selectedTraits={selectedTraits}
		collectionBasePath={collectionBasePath}
		browserBasePath={browserBasePath}
		requestCursor={requestCursor}
		{traitFacetPanel}
		tokenStatus="listed_then_unlisted"
		displayMode={displayMode}
	/>
</section>
