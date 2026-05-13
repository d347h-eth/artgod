<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { TRADING_JOB_STATUS } from '@artgod/shared/types';
	import type {
		ApiChain,
		ApiBiddingBidBook,
		ApiBiddingCollectionSettings,
		ApiBiddingJob,
		ApiBiddingPriceTier,
		ApiCollection,
		ApiCollectionMediaState,
		ApiTokenAttribute,
		ApiTraitRangeFilter,
		BootstrapStatusApiResponse,
		ApiTokensPage,
		ApiTraitFacet
	} from '$lib/api-types';
	import { getBootstrapStatus } from '$lib/backend-api';
	import {
		BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE,
		buildBiddingAutomationTokenFilterSnapshot,
		buildBiddingAutomationDraftFromSelection,
		canDraftTraitJobFromFilters,
		type BiddingAutomationTokenFilterSnapshot
	} from '$lib/bidding-automation';
	import {
		buildFilteredTokenBatchBiddingSelectionInput,
		buildFilteredTraitBiddingSelectionInput,
		biddingAutomationSelectionStateKey,
		biddingAutomationTokenSelectionState,
		createBiddingAutomationController,
		describeBiddingAutomationSelection,
		isCleanFilteredTokenBatchSelection,
		type ToggleBiddingTokenInput
	} from '$lib/bidding-automation-controller';
	import { emptyBiddingBidBook } from '$lib/bidding-empty-state';
	import { buildCollectionNavigation } from '$lib/collection-navigation';
	import BiddingAutomationPanel from '$lib/components/BiddingAutomationPanel.svelte';
	import BiddingPriceTierPanel from '$lib/components/BiddingPriceTierPanel.svelte';
	import BiddingSelectionControls from '$lib/components/BiddingSelectionControls.svelte';
	import CollectionJumpForm from '$lib/components/CollectionJumpForm.svelte';
	import CollectionPageLayout from '$lib/components/CollectionPageLayout.svelte';
	import KeyboardShortcutsHelp from '$lib/components/KeyboardShortcutsHelp.svelte';
	import { createKeyboardShortcutsHelpController } from '$lib/components/keyboard-shortcuts-help-controller';
	import TraitFacetPanelControls from '$lib/components/TraitFacetPanelControls.svelte';
	import TokenBrowserView from '$lib/components/TokenBrowserView.svelte';
	import { normalizeBasePath } from '$lib/route-paths';
	import {
		collectionBiddingNavigationVisibilityForDeployment,
		IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
		publicCollectionTokensPath
	} from '$lib/runtime/public-deployment';
	import { createTraitFacetPanelController } from '$lib/components/trait-facet-panel-controller';
	import { buildTokenBrowserHref } from '$lib/token-browser-query';

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
		displayMode,
		biddingSettings,
		priceTiers = []
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
		biddingSettings: ApiBiddingCollectionSettings;
		priceTiers?: ApiBiddingPriceTier[];
	} = $props();

	const BOOTSTRAP_POLL_INTERVAL_MS = 5_000;
	const traitFacetPanel = createTraitFacetPanelController();
	const traitFacetPanelState = traitFacetPanel.state;
	const keyboardShortcutsHelp = createKeyboardShortcutsHelpController();
	const biddingAutomation = createBiddingAutomationController();
	const biddingAutomationState = biddingAutomation.state;

	let bootstrapStatus = $state<BootstrapStatusApiResponse | null>(null);
	let bootstrapLoading = $state(false);
	let bootstrapError = $state<string | null>(null);
	let bootstrapRequestInFlight = false;
	let changedBiddingJobs = $state<ApiBiddingJob[]>([]);
	let activeBiddingSettings = $state<ApiBiddingCollectionSettings>(biddingSettings);
	let activePriceTiers = $state<ApiBiddingPriceTier[]>(priceTiers);
	let priceTierPanelOpen = $state(false);
	let visibleBrowserTokenIds = $state<string[]>(tokens.items.map((token) => token.tokenId));
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
	const canBidOnTraits = $derived(
		canDraftTraitJobFromFilters({ selectedTraits, selectedTraitRanges })
	);
	const canRefineTokenSelectionToVisiblePage = $derived(tokens.totalPages > 1);
	const tokenActionLabel = $derived(
		isAllFilteredTokenSelectionActive() && canRefineTokenSelectionToVisiblePage
			? 'bid on this page'
			: 'bid on all tokens'
	);

	$effect(() => {
		activeBiddingSettings = biddingSettings;
	});

	$effect(() => {
		activePriceTiers = priceTiers;
	});

	$effect(() => {
		visibleBrowserTokenIds = tokens.items.map((token) => token.tokenId);
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

	function activeCollectionRef(): string | null {
		if (!collection) return null;
		return collection.slug;
	}

	function collectionNavigation() {
		return buildCollectionNavigation({
			basePath,
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
			bidding: {
				...collectionBiddingNavigationVisibilityForDeployment()
			}
		});
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

	function bidOnFilteredTraits(): void {
		if (!canBidOnTraits) return;
		biddingAutomation.selectFilteredTokens(
			buildFilteredTraitBiddingSelectionInput({
				tokenCount: tokens.totalItems,
				filter: currentBiddingFilterSnapshot()
			})
		);
		expandBiddingAutomationPanel();
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
				tokenCount: tokens.totalItems,
				filter: currentBiddingFilterSnapshot()
			})
		);
		expandBiddingAutomationPanel();
	}

	function toggleVisibleTokenSelection(request: ToggleBiddingTokenInput): void {
		biddingAutomation.toggleToken(request);
	}

	function biddingTokenSelectionState(tokenId: string, stateKey: string) {
		return biddingAutomationTokenSelectionState(currentBiddingSelection, tokenId, stateKey);
	}

	function isAllFilteredTokenSelectionActive(): boolean {
		return isCleanFilteredTokenBatchSelection(currentBiddingSelection);
	}

	function currentBiddingFilterSnapshot(): BiddingAutomationTokenFilterSnapshot {
		return buildBiddingAutomationTokenFilterSnapshot({
			source: BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE.TokenBrowser,
			selectedTraits,
			selectedTraitRanges,
			traitJoinMode: 'and',
			tokenStatus,
			makerAddress: null
		});
	}

	function activeBiddingFilterKey(): string {
		return JSON.stringify({
			tokenStatus,
			selectedTraits,
			selectedTraitRanges
		});
	}

	function clearBiddingSelection(): void {
		biddingAutomation.clearSelection();
	}

	function handleVisibleTokenIdsChange(tokenIds: string[]): void {
		visibleBrowserTokenIds = tokenIds;
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
	}

	function emptyBidBook(): ApiBiddingBidBook {
		return emptyBiddingBidBook();
	}
</script>

<CollectionPageLayout
	navigation={collectionNavigation()}
	activeSection="tokens"
	activeTokenStatus={tokenStatus}
	collectionAvailable={collection !== null}
	showCustomization={!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}
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
			{#if !IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}
				<div class="panel-top-actions-row">
					<BiddingSelectionControls
						summary={biddingSelectionSummary}
						showTraitAction={canBidOnTraits}
						showTierAction
						tierActionActive={priceTierPanelOpen}
						tokenActionLabel={tokenActionLabel}
						tokenActionDisabled={tokens.totalItems === 0}
						onToggleTiers={togglePriceTierPanel}
						onBidOnTraits={bidOnFilteredTraits}
						onBidOnTokens={() => bidOnFilteredTokens(visibleBrowserTokenIds)}
						onClear={clearBiddingSelection}
					/>
				</div>
			{/if}
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
		collectionBasePath={normalizeBasePath(basePath)}
		browserBasePath={normalizeBasePath(basePath)}
		requestCursor={requestCursor}
		onResetTraits={onResetTraits}
		{traitFacetPanel}
		{keyboardShortcutsHelp}
		collectionNavigation={collectionNavigation()}
		tokenStatus={tokenStatus}
		displayMode={displayMode}
		selection={!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT
			? {
					stateKey: biddingSelectionStateKey,
					state: biddingTokenSelectionState,
					onToggle: toggleVisibleTokenSelection
				}
			: null}
		onVisibleTokenIdsChange={handleVisibleTokenIdsChange}
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
			bidBook={emptyBidBook()}
			biddingSettings={activeBiddingSettings}
			priceTiers={activePriceTiers}
			expandSignal={biddingPanelExpandSignal}
			onClose={closeBiddingAutomationPanel}
			onJobsChange={handleBiddingJobsChanged}
		/>
	{/if}
</CollectionPageLayout>
