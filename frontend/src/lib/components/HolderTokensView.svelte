<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		DEFAULT_BIDDING_BID_BOOK_LIVE_REFRESH_CONFIG,
		type BiddingBidBookLiveRefreshConfig
	} from '@artgod/shared/config/bidding';
	import { TOKEN_BROWSER_STATUS, TRADING_JOB_STATUS } from '@artgod/shared/types';
	import type {
		ApiChain,
		ApiBiddingCollectionSettings,
		ApiBiddingJob,
		ApiBiddingPriceTier,
		ApiCollection,
		ApiCollectionMediaState,
		ApiTokenCard,
		ApiTokenAttribute,
		ApiTraitRangeFilter,
		ApiTokensPage,
		ApiTraitFacet
	} from '$lib/api-types';
	import {
		BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE,
		buildBiddingAutomationDraftFromSelection,
		type BiddingAutomationTokenFilterSnapshot
	} from '$lib/bidding-automation';
	import {
		buildFilteredTokenBatchBiddingSelectionInput,
		biddingAutomationSelectionStateKey,
		biddingAutomationTokenSelectionState,
		createBiddingAutomationController,
		describeBiddingAutomationSelection,
		isCleanFilteredTokenBatchSelection,
		type ToggleBiddingTokenInput
	} from '$lib/bidding-automation-controller';
	import { resolveBiddingTokenActionLabel } from '$lib/bidding-selection-actions';
	import { resolveTokenBrowserBiddingSelectionControlPolicy } from '$lib/bidding-selection-control-policy';
	import { buildCollectionNavigation } from '$lib/collection-navigation';
	import BiddingAutomationPanel from '$lib/components/BiddingAutomationPanel.svelte';
	import BiddingPriceTierPanel from '$lib/components/BiddingPriceTierPanel.svelte';
	import BiddingSelectionControls from '$lib/components/BiddingSelectionControls.svelte';
	import CollectionJumpForm from '$lib/components/CollectionJumpForm.svelte';
	import CollectionPageLayout from '$lib/components/CollectionPageLayout.svelte';
	import KeyboardShortcutsHelp from '$lib/components/KeyboardShortcutsHelp.svelte';
	import { createKeyboardShortcutsHelpController } from '$lib/components/keyboard-shortcuts-help-controller';
	import {
		collectionBiddingNavigationVisibilityForDeployment,
		IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
		publicCollectionTokensPath
	} from '$lib/runtime/public-deployment';
	import {
		buildTokenBrowserBiddingFilterSnapshot,
		tokenBrowserBiddingFilterKey,
		visibleBiddableTokenIds
	} from '$lib/token-browser-bidding';
	import { createTokenBiddingPanelBidBookController } from '$lib/token-bidding-panel-bid-book-controller';
	import TraitFacetPanelControls from '$lib/components/TraitFacetPanelControls.svelte';
	import TokenBrowserView from '$lib/components/TokenBrowserView.svelte';
	import { createTraitFacetPanelController } from '$lib/components/trait-facet-panel-controller';
	import { buildOwnerTokensHref } from '$lib/token-browser-query';

	let {
		chain,
		collection,
		tokens,
		facets,
		selectedTraits,
		selectedTraitRanges,
		media,
		collectionBasePath,
		browserBasePath,
		owner,
		requestCursor,
		displayMode,
		biddingSettings,
		priceTiers = [],
		bidBookLiveRefreshConfig = DEFAULT_BIDDING_BID_BOOK_LIVE_REFRESH_CONFIG
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
		biddingSettings: ApiBiddingCollectionSettings;
		priceTiers?: ApiBiddingPriceTier[];
		bidBookLiveRefreshConfig?: BiddingBidBookLiveRefreshConfig;
	} = $props();

	const traitFacetPanel = createTraitFacetPanelController();
	const traitFacetPanelState = traitFacetPanel.state;
	const keyboardShortcutsHelp = createKeyboardShortcutsHelpController();
	const biddingAutomation = createBiddingAutomationController();
	const biddingAutomationState = biddingAutomation.state;
	const tokenPanelBidBook = createTokenBiddingPanelBidBookController();
	const tokenPanelBidBookState = tokenPanelBidBook.state;

	let changedBiddingJobs = $state<ApiBiddingJob[]>([]);
	let activeBiddingSettings = $state<ApiBiddingCollectionSettings>(biddingSettings);
	let activePriceTiers = $state<ApiBiddingPriceTier[]>(priceTiers);
	let priceTierPanelOpen = $state(false);
	let visibleBiddableBrowserTokenIds = $state<string[]>(visibleBiddableTokenIds(tokens));
	let lastBiddingFilterKey = $state('');
	let biddingPanelExpandSignal = $state(0);
	const currentBiddingSelection = $derived($biddingAutomationState.selection);
	const selectedBiddingDraft = $derived(
		currentBiddingSelection ? buildBiddingAutomationDraftFromSelection(currentBiddingSelection) : null
	);
	const biddingAutomationPanelOpen = $derived(selectedBiddingDraft !== null);
	const biddingSelectionStateKey = $derived(
		biddingAutomationSelectionStateKey(currentBiddingSelection)
	);
	const biddingSelectionSummary = $derived(
		describeBiddingAutomationSelection(currentBiddingSelection)
	);
	const biddingFilterKey = $derived(activeBiddingFilterKey());
	const canRefineTokenSelectionToVisiblePage = $derived(tokens.totalPages > 1);
	const tokenActionLabel = $derived(
		resolveBiddingTokenActionLabel({
			allFilteredSelectionActive: isAllFilteredTokenSelectionActive(),
			canRefineTokenSelectionToVisiblePage
		})
	);
	const biddingSelectionControlPolicy = $derived(
		resolveTokenBrowserBiddingSelectionControlPolicy({
			publicSingleCollection: IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
			canBidOnTraits: false
		})
	);

	$effect(() => {
		activeBiddingSettings = biddingSettings;
	});

	$effect(() => {
		activePriceTiers = priceTiers;
	});

	$effect(() => {
		visibleBiddableBrowserTokenIds = visibleBiddableTokenIds(tokens);
	});

	onMount(() => {
		const refresh = tokenPanelBidBook.start(panelBidBookContext, () => bidBookLiveRefreshConfig);
		return () => refresh.stop();
	});

	$effect(() => {
		tokenPanelBidBook.sync(panelBidBookContext());
	});

	$effect(() => {
		const nextKey = biddingFilterKey;
		if (!lastBiddingFilterKey) {
			lastBiddingFilterKey = nextKey;
			return;
		}
		if (nextKey === lastBiddingFilterKey) {
			return;
		}
		lastBiddingFilterKey = nextKey;
		biddingAutomation.clearSelection();
	});

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

	function collectionNavigation() {
		return buildCollectionNavigation({
			basePath: collectionBasePath,
			mediaMode: media.selectedMode,
			selectedTraits,
			selectedTraitRanges,
			token: {
				limit: tokens.limit,
				displayMode
			},
			activity: {
				limit: tokens.limit,
				kind: 'sales'
			},
			activityEventFeeds: collection?.activityEventFeeds ?? [],
			collectionExtensions: collection?.extensions ?? [],
			bidding: {
				...collectionBiddingNavigationVisibilityForDeployment()
			}
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

	function bidOnFilteredTokens(nextVisibleTokenIds: string[]): void {
		if (isAllFilteredTokenSelectionActive()) {
			if (canRefineTokenSelectionToVisiblePage) {
				biddingAutomation.selectExplicitTokens(nextVisibleTokenIds);
			}
			expandBiddingAutomationPanel();
			return;
		}
		biddingAutomation.selectFilteredTokens(
			buildFilteredTokenBatchBiddingSelectionInput({
				tokenCount: tokens.marketplaceBiddingSupportedTotalItems,
				filter: currentBiddingFilterSnapshot()
			})
		);
		expandBiddingAutomationPanel();
	}

	function toggleVisibleTokenSelection(request: ToggleBiddingTokenInput): void {
		biddingAutomation.toggleToken(request);
	}

	function biddingTokenSelectionState(token: ApiTokenCard, stateKey: string) {
		return biddingAutomationTokenSelectionState(currentBiddingSelection, token.tokenId, stateKey, {
			marketplaceBiddingSupported: token.marketplaceBiddingSupported
		});
	}

	function isAllFilteredTokenSelectionActive(): boolean {
		return isCleanFilteredTokenBatchSelection(currentBiddingSelection);
	}

	function currentBiddingFilterSnapshot(): BiddingAutomationTokenFilterSnapshot {
		return buildTokenBrowserBiddingFilterSnapshot({
			source: BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE.TokenBrowser,
			selectedTraits,
			facets,
			selectedTraitRanges,
			tokenStatus: TOKEN_BROWSER_STATUS.ListedThenUnlisted,
			ownerAddress: owner,
			makerAddress: null
		});
	}

	function activeBiddingFilterKey(): string {
		return tokenBrowserBiddingFilterKey({
			tokenStatus: TOKEN_BROWSER_STATUS.ListedThenUnlisted,
			ownerAddress: owner,
			selectedTraits,
			selectedTraitRanges
		});
	}

	function clearBiddingSelection(): void {
		biddingAutomation.clearSelection();
	}

	function handleVisibleBiddableTokenIdsChange(tokenIds: string[]): void {
		visibleBiddableBrowserTokenIds = tokenIds;
	}

	function togglePriceTierPanel(): void {
		priceTierPanelOpen = !priceTierPanelOpen;
	}

	function handleBiddingSettingsChanged(nextSettings: ApiBiddingCollectionSettings): void {
		activeBiddingSettings = nextSettings;
	}

	function handlePriceTiersChanged(nextTiers: ApiBiddingPriceTier[]): void {
		activePriceTiers = nextTiers;
	}

	function expandBiddingAutomationPanel(): void {
		biddingPanelExpandSignal += 1;
	}

	function closeBiddingAutomationPanel(): void {
		biddingAutomation.clearSelection();
	}

	function handleBiddingJobsChanged(jobs: ApiBiddingJob[]): void {
		changedBiddingJobs = jobs.filter((job) => job.status !== TRADING_JOB_STATUS.Archived);
		void tokenPanelBidBook.refreshNow(panelBidBookContext());
	}

	function panelBidBookContext() {
		return {
			fetchFn: fetch,
			chain,
			collection,
			draft: selectedBiddingDraft,
			open: biddingAutomationPanelOpen
		};
	}
</script>

<CollectionPageLayout
	navigation={collectionNavigation()}
	activeSection={null}
	collectionAvailable={collection !== null}
	showCustomization={!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}
>
	{#snippet breadcrumbs()}
		{#if collection}
			{#if IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}
				<a href={collectionNavigation().hrefs.asks}>{collection.slug}</a>
				<span class="breadcrumbs-separator">/</span>
				<a href={collectionNavigation().hrefs.holders}>holders</a>
				<span class="breadcrumbs-separator">/</span>
				<span class="breadcrumbs-current">{owner}</span>
			{:else}
				<a href={collectionsHref()}>collections</a>
				<span class="breadcrumbs-separator">/</span>
				<a href={collectionNavigation().hrefs.asks}>{collection.slug}</a>
				<span class="breadcrumbs-separator">/</span>
				<a href={collectionNavigation().hrefs.holders}>holders</a>
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
		{#if !IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT && biddingSelectionControlPolicy.renderRow}
			<div class="panel-top-actions-row">
				<BiddingSelectionControls
					summary={biddingSelectionSummary}
					showTraitAction={biddingSelectionControlPolicy.showTraitAction}
					showTokenAction={biddingSelectionControlPolicy.showTokenAction}
					showTierAction={biddingSelectionControlPolicy.showTierAction}
					tierActionActive={priceTierPanelOpen}
					tokenActionLabel={tokenActionLabel}
					tokenActionDisabled={tokens.marketplaceBiddingSupportedTotalItems === 0}
					onToggleTiers={togglePriceTierPanel}
					onBidOnTokens={() => bidOnFilteredTokens(visibleBiddableBrowserTokenIds)}
					onClear={clearBiddingSelection}
				/>
			</div>
		{/if}
	{/if}
	{/snippet}

	{#if !IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT && priceTierPanelOpen && collection}
		<BiddingPriceTierPanel
			{chain}
			{collection}
			settings={activeBiddingSettings}
			tiers={activePriceTiers}
			onSettingsChange={handleBiddingSettingsChanged}
			onTiersChange={handlePriceTiersChanged}
			onJobsChange={handleBiddingJobsChanged}
			onClose={togglePriceTierPanel}
		/>
	{/if}

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
		collectionNavigation={collectionNavigation()}
		tokenStatus={TOKEN_BROWSER_STATUS.ListedThenUnlisted}
		displayMode={displayMode}
		selection={!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT
			? {
					stateKey: biddingSelectionStateKey,
					state: biddingTokenSelectionState,
					onToggle: toggleVisibleTokenSelection
				}
			: null}
		onVisibleBiddableTokenIdsChange={handleVisibleBiddableTokenIdsChange}
		onToggleTiers={!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT ? togglePriceTierPanel : null}
	/>
	{#if !IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT && collection}
		<BiddingAutomationPanel
			open={biddingAutomationPanelOpen}
			{chain}
			{collection}
			token={null}
			job={changedBiddingJobs.length === 1 ? changedBiddingJobs[0] : null}
			draft={selectedBiddingDraft}
			bidBook={$tokenPanelBidBookState.bidBook}
			biddingSettings={activeBiddingSettings}
			priceTiers={activePriceTiers}
			expandSignal={biddingPanelExpandSignal}
			onClose={closeBiddingAutomationPanel}
			onJobsChange={handleBiddingJobsChanged}
		/>
	{/if}
</CollectionPageLayout>
