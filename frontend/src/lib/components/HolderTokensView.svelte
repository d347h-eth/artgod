<script lang="ts">
	import { goto } from '$app/navigation';
	import type {
		ApiChain,
		ApiCollection,
		ApiTokenAttribute,
		ApiTokensPage,
		ApiTraitFacet
	} from '$lib/api-types';
	import CollectionPageLayout from '$lib/components/CollectionPageLayout.svelte';
	import TraitFacetPanelControls from '$lib/components/TraitFacetPanelControls.svelte';
	import TokenBrowserView from '$lib/components/TokenBrowserView.svelte';
	import { createTraitFacetPanelController } from '$lib/components/trait-facet-panel-controller';
	import { buildCollectionActivityHref } from '$lib/activity-query';
	import { buildOwnerTokensHref, buildTokenBrowserHref } from '$lib/token-browser-query';

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
		return buildOwnerTokensHref({
			basePath: browserBasePath,
			limit: tokens.limit,
			displayMode,
			selectedTraits: []
		});
	}

	function collectionTokensHref(): string {
		return buildTokenBrowserHref({
			basePath: collectionBasePath,
			limit: tokens.limit,
			displayMode,
			tokenStatus: 'listed',
			selectedTraits
		});
	}

	function collectionActivitiesHref(): string {
		return buildCollectionActivityHref({
			basePath: collectionBasePath,
			limit: tokens.limit,
			kind: 'sales',
			selectedTraits
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

<CollectionPageLayout
	tokensHref={collectionTokensHref()}
	activitiesHref={collectionActivitiesHref()}
	holdersHref={holdersBasePath}
	activeSection="holders"
	collectionAvailable={collection !== null}
>
	{#snippet breadcrumbs()}
		<a href={collectionsHref()}>collections</a>
		{#if collection}
			<span class="breadcrumbs-separator">/</span>
			<a href={collectionTokensHref()}>{collection.slug}</a>
			<span class="breadcrumbs-separator">/</span>
			<a href={holdersBasePath}>holders</a>
			<span class="breadcrumbs-separator">/</span>
			<span class="breadcrumbs-current">{owner}</span>
		{/if}
	{/snippet}
	{#snippet topActions()}
	{#if collection}
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
	{/if}
	{/snippet}

	<TokenBrowserView
		chain={chain}
		collection={collection}
		tokens={tokens}
		facets={facets}
		selectedTraits={selectedTraits}
		collectionBasePath={collectionBasePath}
		browserBasePath={browserBasePath}
		requestCursor={requestCursor}
		onResetTraits={onResetTraits}
		{traitFacetPanel}
		tokenStatus="listed_then_unlisted"
		displayMode={displayMode}
	/>
</CollectionPageLayout>
