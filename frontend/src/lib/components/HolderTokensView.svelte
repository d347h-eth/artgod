<script lang="ts">
	import { goto } from '$app/navigation';
	import type {
		ApiChain,
		ApiCollection,
		ApiCollectionMediaState,
		ApiTokenAttribute,
		ApiTraitRangeFilter,
		ApiTokensPage,
		ApiTraitFacet
	} from '$lib/api-types';
	import CollectionJumpForm from '$lib/components/CollectionJumpForm.svelte';
	import CollectionPageLayout from '$lib/components/CollectionPageLayout.svelte';
	import KeyboardShortcutsHelp from '$lib/components/KeyboardShortcutsHelp.svelte';
	import { createKeyboardShortcutsHelpController } from '$lib/components/keyboard-shortcuts-help-controller';
	import { appendMediaModeParam } from '$lib/media-mode';
	import { withQuery } from '$lib/route-paths';
	import { buildCollectionBiddingHref } from '$lib/bidding-query';
	import {
		IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
		publicCollectionTokensPath
	} from '$lib/runtime/public-deployment';
	import TraitFacetPanelControls from '$lib/components/TraitFacetPanelControls.svelte';
	import TokenBrowserView from '$lib/components/TokenBrowserView.svelte';
	import { createTraitFacetPanelController } from '$lib/components/trait-facet-panel-controller';
	import { buildCollectionActivityHref } from '$lib/activity-query';
	import { buildCollectionCustomizationHref } from '$lib/customization-query';
	import { buildOwnerTokensHref, buildTokenBrowserHref } from '$lib/token-browser-query';

	let {
		chain,
		collection,
		tokens,
		facets,
		selectedTraits,
		selectedTraitRanges,
		media,
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
		selectedTraitRanges: ApiTraitRangeFilter[];
		media: ApiCollectionMediaState;
		collectionBasePath: string;
		holdersBasePath: string;
		browserBasePath: string;
		owner: string;
		requestCursor: string | null;
		displayMode: 'grid' | 'table';
	} = $props();

	const traitFacetPanel = createTraitFacetPanelController();
	const traitFacetPanelState = traitFacetPanel.state;
	const keyboardShortcutsHelp = createKeyboardShortcutsHelpController();

	function collectionsHref(): string {
		if (IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) return publicCollectionTokensPath();
		if (!chain) return '/';
		return `/${chain.slug}`;
	}

	function resetTraitsHref(): string {
		return buildOwnerTokensHref({
			basePath: browserBasePath,
			limit: tokens.limit,
			displayMode,
			selectedTraits: [],
			selectedTraitRanges: [],
			mediaMode: media.selectedMode
		});
	}

	function collectionTokensHref(): string {
		return buildTokenBrowserHref({
			basePath: collectionBasePath,
			limit: tokens.limit,
			displayMode,
			tokenStatus: 'listed',
			selectedTraits,
			selectedTraitRanges,
			mediaMode: media.selectedMode
		});
	}

	function collectionActivitiesHref(): string {
		return buildCollectionActivityHref({
			basePath: collectionBasePath,
			limit: tokens.limit,
			kind: 'sales',
			selectedTraits,
			selectedTraitRanges,
			mediaMode: media.selectedMode
		});
	}

	function holdersHref(): string {
		const query = new URLSearchParams();
		appendMediaModeParam(query, media.selectedMode);
		return withQuery(holdersBasePath, query);
	}

	function customizationHref(): string {
		return buildCollectionCustomizationHref({
			basePath: collectionBasePath,
			selectedTraits,
			selectedTraitRanges,
			mediaMode: media.selectedMode
		});
	}

	function biddingHref(): string {
		return buildCollectionBiddingHref({
			basePath: collectionBasePath,
			selectedTraits,
			selectedTraitRanges,
			mediaMode: media.selectedMode
		});
	}

	async function onResetTraits(): Promise<void> {
		await goto(resetTraitsHref(), {
			invalidateAll: true,
			keepFocus: true,
			noScroll: true
		});
	}

	async function applyTraitFilters(
		nextTraits: ApiTokenAttribute[],
		nextRanges: ApiTraitRangeFilter[]
	): Promise<void> {
		await goto(
			buildOwnerTokensHref({
				basePath: browserBasePath,
				limit: tokens.limit,
				displayMode,
				selectedTraits: nextTraits,
				selectedTraitRanges: nextRanges,
				mediaMode: media.selectedMode
			}),
			{
				invalidateAll: true,
				keepFocus: true,
				noScroll: true
			}
		);
	}
</script>

<CollectionPageLayout
	tokensHref={collectionTokensHref()}
	activitiesHref={collectionActivitiesHref()}
	holdersHref={holdersHref()}
	customizationHref={customizationHref()}
	biddingHref={biddingHref()}
	activeSection={null}
	collectionAvailable={collection !== null}
	showCustomization={!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}
	showBidding={!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}
>
	{#snippet breadcrumbs()}
		{#if collection}
			{#if IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}
				<a href={collectionTokensHref()}>{collection.slug}</a>
				<span class="breadcrumbs-separator">/</span>
				<a href={holdersHref()}>holders</a>
				<span class="breadcrumbs-separator">/</span>
				<span class="breadcrumbs-current">{owner}</span>
			{:else}
				<a href={collectionsHref()}>collections</a>
				<span class="breadcrumbs-separator">/</span>
				<a href={collectionTokensHref()}>{collection.slug}</a>
				<span class="breadcrumbs-separator">/</span>
				<a href={holdersHref()}>holders</a>
				<span class="breadcrumbs-separator">/</span>
				<span class="breadcrumbs-current">{owner}</span>
			{/if}
		{/if}
	{/snippet}
	{#snippet headerActions()}
		{#if collection}
			<CollectionJumpForm
				chainRef={chain?.slug ?? ''}
				basePath={collectionBasePath}
				mediaMode={media.selectedMode}
			/>
		{/if}
		<KeyboardShortcutsHelp {keyboardShortcutsHelp} />
	{/snippet}
	{#snippet topActions()}
	{#if collection}
		<div class="panel-top-actions-row">
			<p class="muted">tokens currently held by <span class="mono">{owner}</span></p>
		</div>
		<div class="panel-top-actions-row">
			<TraitFacetPanelControls
				hasActiveFilters={selectedTraits.length > 0 || selectedTraitRanges.length > 0}
				collapsed={$traitFacetPanelState.collapsed}
				onToggleCollapsed={traitFacetPanel.toggle}
				onReset={onResetTraits}
				{selectedTraits}
				selectedRanges={selectedTraitRanges}
				onSelectedFiltersChange={applyTraitFilters}
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
		selectedTraitRanges={selectedTraitRanges}
		{media}
		collectionBasePath={collectionBasePath}
		browserBasePath={browserBasePath}
		requestCursor={requestCursor}
		onResetTraits={onResetTraits}
		{traitFacetPanel}
		{keyboardShortcutsHelp}
		tokenStatus="listed_then_unlisted"
		displayMode={displayMode}
	/>
</CollectionPageLayout>
