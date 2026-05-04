<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import type {
		ApiChain,
		ApiCollection,
		ApiCollectionMediaState,
		ApiTokenAttribute,
		ApiTraitRangeFilter,
		BootstrapStatusApiResponse,
		ApiTokensPage,
		ApiTraitFacet
	} from '$lib/api-types';
	import { getBootstrapStatus } from '$lib/backend-api';
	import { buildCollectionActivityQuery } from '$lib/activity-query';
	import CollectionJumpForm from '$lib/components/CollectionJumpForm.svelte';
	import CollectionPageLayout from '$lib/components/CollectionPageLayout.svelte';
	import KeyboardShortcutsHelp from '$lib/components/KeyboardShortcutsHelp.svelte';
	import { createKeyboardShortcutsHelpController } from '$lib/components/keyboard-shortcuts-help-controller';
	import TraitFacetPanelControls from '$lib/components/TraitFacetPanelControls.svelte';
	import TokenBrowserView from '$lib/components/TokenBrowserView.svelte';
	import { buildCollectionBiddingQuery } from '$lib/bidding-query';
	import { joinPath, normalizeBasePath, withQuery } from '$lib/route-paths';
	import {
		IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
		publicCollectionTokensPath
	} from '$lib/runtime/public-deployment';
	import { createTraitFacetPanelController } from '$lib/components/trait-facet-panel-controller';
	import { buildCollectionCustomizationHref } from '$lib/customization-query';
	import { buildTokenBrowserHref } from '$lib/token-browser-query';
	import {
		applyCollectionTokenNavigationPreferenceToQuery,
		buildCollectionTokenNavigationQuery,
		readCollectionTokenNavigationPreference,
		writeCollectionTokenNavigationPreference
	} from '$lib/token-browser-navigation-preferences';

	let {
		chain,
		collection,
		tokens,
		facets,
		selectedTraits,
		selectedTraitRanges,
		media,
		basePath,
		requestCursor,
		tokenStatus,
		displayMode
	}: {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		tokens: ApiTokensPage;
		facets: ApiTraitFacet[];
		selectedTraits: ApiTokenAttribute[];
		selectedTraitRanges: ApiTraitRangeFilter[];
		media: ApiCollectionMediaState;
		basePath: string;
		requestCursor: string | null;
		tokenStatus: 'listed' | 'all';
		displayMode: 'grid' | 'table';
	} = $props();

	const BOOTSTRAP_POLL_INTERVAL_MS = 5_000;
	const traitFacetPanel = createTraitFacetPanelController();
	const traitFacetPanelState = traitFacetPanel.state;
	const keyboardShortcutsHelp = createKeyboardShortcutsHelpController();
	let tokenNavigationPreferenceReady = $state(false);

	let bootstrapStatus = $state<BootstrapStatusApiResponse | null>(null);
	let bootstrapLoading = $state(false);
	let bootstrapError = $state<string | null>(null);
	let bootstrapRequestInFlight = false;

	onMount(() => {
		const preferredQuery = applyCollectionTokenNavigationPreferenceToQuery(
			basePath,
			new URLSearchParams(window.location.search),
			readCollectionTokenNavigationPreference(basePath)
		);
		const preferredSuffix = preferredQuery.toString();
		const preferredHref = `${window.location.pathname}${preferredSuffix ? `?${preferredSuffix}` : ''}${window.location.hash}`;
		const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
		if (preferredHref !== currentHref) {
			void goto(preferredHref, {
				replaceState: true,
				invalidateAll: true,
				keepFocus: true,
				noScroll: true
			}).finally(() => {
				tokenNavigationPreferenceReady = true;
			});
			return;
		}
		tokenNavigationPreferenceReady = true;
	});

	$effect(() => {
		if (!tokenNavigationPreferenceReady) return;
		writeCollectionTokenNavigationPreference(basePath, { tokenStatus });
	});

	$effect(() => {
		if (!browser || !chain || !collection || collection.status === 'live') {
			bootstrapStatus = null;
			bootstrapError = null;
			return;
		}
		void refreshBootstrapStatus();
		const timer = setInterval(() => {
			void refreshBootstrapStatus();
		}, BOOTSTRAP_POLL_INTERVAL_MS);
		return () => clearInterval(timer);
	});

	function collectionsHref(): string {
		if (IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) return publicCollectionTokensPath();
		if (!chain) return '/';
		return `/${chain.slug}`;
	}

	function activeCollectionRef(): string | null {
		if (!collection) return null;
		return collection.slug;
	}

	function tokensSectionQuery(): URLSearchParams {
		return buildCollectionTokenNavigationQuery({
			limit: tokens.limit,
			displayMode,
			selectedTraits,
			selectedTraitRanges,
			mediaMode: media.selectedMode
		});
	}

	function activitiesSectionQuery(): URLSearchParams {
		return buildCollectionActivityQuery({
			limit: tokens.limit,
			kind: 'sales',
			selectedTraits,
			selectedTraitRanges,
			mediaMode: media.selectedMode
		});
	}

	function holdersSectionHref(): string {
		const query = new URLSearchParams();
		query.set('media_mode', media.selectedMode);
		return withQuery(joinPath(basePath, 'holders'), query);
	}

	function resetTraitsHref(): string {
		return buildTokenBrowserHref({
			basePath,
			limit: tokens.limit,
			displayMode,
			tokenStatus,
			selectedTraits: [],
			selectedTraitRanges: [],
			mediaMode: media.selectedMode
		});
	}

	function customizationSectionHref(): string {
		return buildCollectionCustomizationHref({
			basePath,
			selectedTraits,
			selectedTraitRanges,
			mediaMode: media.selectedMode
		});
	}

	function biddingSectionQuery(): URLSearchParams {
		return buildCollectionBiddingQuery({
			selectedTraits,
			selectedTraitRanges,
			mediaMode: media.selectedMode
		});
	}

	function latestRunHref(): string | null {
		if (!chain || !bootstrapStatus?.latestRun) return null;
		return `/${chain.slug}/bootstrap-runs/${bootstrapStatus.latestRun.runId}`;
	}

	async function refreshBootstrapStatus(): Promise<void> {
		if (!chain || !collection) return;
		if (bootstrapRequestInFlight) return;
		bootstrapRequestInFlight = true;
		bootstrapLoading = true;
		bootstrapError = null;
		try {
			const collectionRef = activeCollectionRef();
			if (!collectionRef) return;
			const response = await getBootstrapStatus(fetch, chain.slug, collectionRef);
			bootstrapStatus = response;
		} catch (error) {
			bootstrapError = error instanceof Error ? error.message : 'bootstrap status request failed';
		} finally {
			bootstrapLoading = false;
			bootstrapRequestInFlight = false;
		}
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
			buildTokenBrowserHref({
				basePath,
				limit: tokens.limit,
				displayMode,
				tokenStatus,
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
	tokensBasePath={basePath}
	tokensQuery={tokensSectionQuery()}
	activitiesBasePath={basePath}
	activitiesQuery={activitiesSectionQuery()}
	holdersHref={holdersSectionHref()}
	customizationHref={customizationSectionHref()}
	biddingBasePath={basePath}
	biddingQuery={biddingSectionQuery()}
	activeSection="tokens"
	activeTokenStatus={tokenStatus}
	collectionAvailable={collection !== null}
	showCustomization={!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}
	showBidding={!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}
>
	{#snippet breadcrumbs()}
		{#if collection}
			{#if IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}
				<span class="breadcrumbs-current">{collection.slug}</span>
			{:else}
				<a href={collectionsHref()}>collections</a>
				<span class="breadcrumbs-separator">/</span>
				<span class="breadcrumbs-current">{collection.slug}</span>
			{/if}
		{/if}
	{/snippet}
	{#snippet headerActions()}
		{#if collection}
			<CollectionJumpForm chainRef={chain?.slug ?? ''} basePath={basePath} mediaMode={media.selectedMode} />
		{/if}
		<KeyboardShortcutsHelp {keyboardShortcutsHelp} />
	{/snippet}
	{#snippet topActions()}
		{#if collection}
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
	{#if collection && collection.status !== 'live'}
		<section class="panel-header">
			<span class="muted">collection status is {collection.status}</span>
			{#if latestRunHref()}
				<a class="button-link" href={latestRunHref() ?? '#'}>latest bootstrap run</a>
			{/if}
			{#if bootstrapLoading}
				<span class="muted">refreshing bootstrap status...</span>
			{/if}
			{#if bootstrapError}
				<span class="muted">{bootstrapError}</span>
			{/if}
		</section>
	{/if}

	<TokenBrowserView
			chain={chain}
			collection={collection}
			tokens={tokens}
		facets={facets}
		selectedTraits={selectedTraits}
		selectedTraitRanges={selectedTraitRanges}
		{media}
		collectionBasePath={normalizeBasePath(basePath)}
		browserBasePath={normalizeBasePath(basePath)}
		requestCursor={requestCursor}
		onResetTraits={onResetTraits}
		{traitFacetPanel}
		{keyboardShortcutsHelp}
		collectionSectionNavigation={{
			tokensBasePath: basePath,
			tokensQuery: tokensSectionQuery(),
			activitiesBasePath: basePath,
			activitiesQuery: activitiesSectionQuery(),
			biddingBasePath: basePath,
			biddingQuery: biddingSectionQuery(),
			showBidding: !IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT
		}}
		tokenStatus={tokenStatus}
		displayMode={displayMode}
	/>
</CollectionPageLayout>
