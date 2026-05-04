<script lang="ts">
	import { goto } from '$app/navigation';
	import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
	import type {
		ApiBiddingBidBook,
		ApiBiddingJob,
		ApiChain,
		ApiCollection,
		ApiCollectionBiddingBidScopeFilter,
		ApiCollectionBiddingTraitFilterJoinMode,
		ApiCollectionMediaState,
		ApiTokenAttribute,
		ApiTokenPresentationSummary,
		ApiTraitFacet,
		ApiTraitRangeFilter
	} from '$lib/api-types';
	import {
		BID_SCOPE_QUERY_PARAM,
		buildCollectionBiddingHref,
		buildCollectionBiddingQuery,
		nextCollectionBiddingBidScopeFilter,
		type CollectionBiddingViewMode
	} from '$lib/bidding-query';
	import {
		writeCollectionBiddingNavigationPreference
	} from '$lib/bidding-navigation-preferences';
	import {
		buildCollectionNavigation,
		handleCollectionSectionShortcut
	} from '$lib/collection-navigation';
	import ActivityTokenCell from '$lib/components/ActivityTokenCell.svelte';
	import BidBookPanel from '$lib/components/BidBookPanel.svelte';
	import CollectionJumpForm from '$lib/components/CollectionJumpForm.svelte';
	import CollectionPageLayout from '$lib/components/CollectionPageLayout.svelte';
	import KeyboardShortcutsHelp from '$lib/components/KeyboardShortcutsHelp.svelte';
	import { createKeyboardShortcutsHelpController } from '$lib/components/keyboard-shortcuts-help-controller';
	import { isKeyboardTextEntryTarget } from '$lib/components/keyboard-targets';
	import CollectionBiddingJobRow from '$lib/components/CollectionBiddingJobRow.svelte';
	import { getTokenPreviewController } from '$lib/components/token-preview-controller';
	import TraitFacetPanel from '$lib/components/TraitFacetPanel.svelte';
	import TraitFacetPanelControls from '$lib/components/TraitFacetPanelControls.svelte';
	import {
		runTraitFacetPanelControlAction,
		type TraitFacetFilterModeOption
	} from '$lib/components/trait-facet-panel-control-action';
	import { createTraitFacetPanelController } from '$lib/components/trait-facet-panel-controller';
	import { joinPath, withQuery } from '$lib/route-paths';
	import {
		IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
		publicCollectionTokensPath
	} from '$lib/runtime/public-deployment';
	import {
		nextSelectedTraits,
		setTraitRangeFilter
	} from '$lib/trait-filters';

	let {
		chain,
		collection,
		jobs,
		bidBook,
		facets,
		media,
		included,
		basePath,
		selectedTraits,
		selectedTraitRanges,
		bidScope,
		traitJoinMode,
		biddingView = 'bid_book',
		showMuted = false,
		mediaMode
	}: {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		jobs: ApiBiddingJob[];
		bidBook: ApiBiddingBidBook;
		facets: ApiTraitFacet[];
		media: ApiCollectionMediaState;
		included: {
			tokensById: Record<string, ApiTokenPresentationSummary>;
			hasTraitSummaryTemplate: boolean;
		};
		basePath: string;
		selectedTraits: ApiTokenAttribute[];
		selectedTraitRanges: ApiTraitRangeFilter[];
		bidScope: ApiCollectionBiddingBidScopeFilter;
		traitJoinMode: ApiCollectionBiddingTraitFilterJoinMode;
		biddingView: CollectionBiddingViewMode;
		showMuted?: boolean;
		mediaMode: string | null;
	} = $props();

	const tokenPreview = getTokenPreviewController();
	const tokenPreviewState = tokenPreview.state;
	const keyboardShortcutsHelp = createKeyboardShortcutsHelpController();
	const keyboardShortcutsHelpState = keyboardShortcutsHelp.state;
	const traitFacetPanel = createTraitFacetPanelController();
	const traitFacetPanelState = traitFacetPanel.state;
	const biddingTraitFilterModes: TraitFacetFilterModeOption[] = [
		{ value: 'or', label: 'or' },
		{ value: 'and', label: 'and' }
	];
	let collectionJobs = $state<ApiBiddingJob[]>(jobs);
	let activeTraits = $state<ApiTokenAttribute[]>(selectedTraits);
	let activeTraitRanges = $state<ApiTraitRangeFilter[]>(selectedTraitRanges);

	const tokenJobCount = $derived(
		collectionJobs.filter((job) => job.target.type === 'token').length
	);
	const nonTokenJobCount = $derived(collectionJobs.length - tokenJobCount);
	const hasActiveTraitFilters = $derived(activeTraits.length > 0 || activeTraitRanges.length > 0);
	const showBidBookTraitFilters = $derived(biddingView === 'bid_book' && bidScope === 'traits');
	const preferredBidBookDemandTraitKey = $derived(
		bidScope === 'traits' && traitJoinMode === 'or' && hasActiveTraitFilters
			? (activeTraits[0]?.key ?? activeTraitRanges[0]?.key ?? null)
			: null
	);

	$effect(() => {
		collectionJobs = jobs;
	});

	$effect(() => {
		activeTraits = selectedTraits;
	});

	$effect(() => {
		activeTraitRanges = selectedTraitRanges;
	});

	$effect(() => {
		writeCollectionBiddingNavigationPreference({ bidScope });
	});

	function collectionsHref(): string {
		if (IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) return publicCollectionTokensPath();
		if (!chain) return '/';
		return `/${chain.slug}`;
	}

	function collectionNavigation() {
		return buildCollectionNavigation({
			basePath,
			mediaMode,
			selectedTraits: activeTraits,
			selectedTraitRanges: activeTraitRanges,
			token: {
				limit: DEFAULT_PAGE_LIMIT,
				displayMode: 'grid'
			},
			activity: {
				limit: DEFAULT_PAGE_LIMIT,
				kind: 'sales'
			},
			bidding: {
				enabled: !IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
				bidScope,
				traitJoinMode,
				viewMode: biddingView,
				showMuted
			}
		});
	}

	function filtersHref(
		traits: ApiTokenAttribute[],
		ranges: ApiTraitRangeFilter[]
	): string {
		return buildCollectionBiddingHref({
			basePath,
			selectedTraits: traits,
			selectedTraitRanges: ranges,
			bidScope,
			traitJoinMode,
			viewMode: biddingView,
			mediaMode,
			showMuted
		});
	}

	function bidScopeHref(
		nextBidScope: ApiCollectionBiddingBidScopeFilter,
		nextView: CollectionBiddingViewMode = 'bid_book'
	): string {
		const query = buildCollectionBiddingQuery({
			selectedTraits: activeTraits,
			selectedTraitRanges: activeTraitRanges,
			bidScope: nextBidScope,
			traitJoinMode,
			viewMode: nextView,
			mediaMode,
			showMuted
		});
		// Keep default collection scope explicit so stored preferences cannot override a scope click.
		query.set(BID_SCOPE_QUERY_PARAM, nextBidScope);
		return withQuery(biddingPath(), query);
	}

	function biddingViewHref(nextView: CollectionBiddingViewMode): string {
		return buildCollectionBiddingHref({
			basePath,
			selectedTraits: activeTraits,
			selectedTraitRanges: activeTraitRanges,
			bidScope,
			traitJoinMode,
			viewMode: nextView,
			mediaMode,
			showMuted
		});
	}

	function biddingPath(): string {
		return joinPath(basePath, 'bidding');
	}

	function biddingReturnQuery(): string {
		return buildCollectionBiddingQuery({
			selectedTraits: activeTraits,
			selectedTraitRanges: activeTraitRanges,
			bidScope,
			traitJoinMode,
			viewMode: biddingView,
			mediaMode,
			showMuted
		}).toString();
	}

	function handleJobUpdated(nextJob: ApiBiddingJob): void {
		collectionJobs = collectionJobs.map((job) => (job.jobId === nextJob.jobId ? nextJob : job));
	}

	function handleJobArchived(jobId: string): void {
		collectionJobs = collectionJobs.filter((job) => job.jobId !== jobId);
	}

	function jobTokenId(job: ApiBiddingJob): string | null {
		return job.target.type === 'token' ? job.target.tokenId : null;
	}

	function jobTokenSummary(job: ApiBiddingJob): ApiTokenPresentationSummary | null {
		const tokenId = jobTokenId(job);
		if (!tokenId) return null;
		return included.tokensById[tokenId] ?? null;
	}

	function traitJoinModeHref(nextMode: ApiCollectionBiddingTraitFilterJoinMode): string {
		return buildCollectionBiddingHref({
			basePath,
			selectedTraits: activeTraits,
			selectedTraitRanges: activeTraitRanges,
			bidScope,
			traitJoinMode: nextMode,
			viewMode: biddingView,
			mediaMode,
			showMuted
		});
	}

	async function onTraitJoinModeChange(nextMode: string): Promise<void> {
		await goto(traitJoinModeHref(nextMode as ApiCollectionBiddingTraitFilterJoinMode), {
			invalidateAll: true,
			keepFocus: true,
			noScroll: true
		});
	}

	async function onTraitPanelControlAction(): Promise<void> {
		await runTraitFacetPanelControlAction({
			hasActiveFilters: hasActiveTraitFilters,
			collapsed: $traitFacetPanelState.collapsed,
			onToggleCollapsed: traitFacetPanel.toggle,
			onSetCollapsed: traitFacetPanel.setCollapsed,
			filterModes: biddingTraitFilterModes,
			selectedFilterMode: traitJoinMode,
			onFilterModeChange: onTraitJoinModeChange
		});
	}

	async function cycleBidScope(): Promise<void> {
		await goto(bidScopeHref(nextCollectionBiddingBidScopeFilter(bidScope), biddingView), {
			invalidateAll: true,
			keepFocus: true,
			noScroll: true
		});
	}

	async function applyTraitFilters(
		nextTraits: ApiTokenAttribute[],
		nextRanges: ApiTraitRangeFilter[]
	): Promise<void> {
		activeTraits = nextTraits;
		activeTraitRanges = nextRanges;
		await goto(filtersHref(nextTraits, nextRanges), {
			invalidateAll: true,
			keepFocus: true,
			noScroll: true
		});
	}

	async function onResetTraits(): Promise<void> {
		await applyTraitFilters([], []);
	}

	async function onTraitToggleWithMode(
		key: string,
		value: string,
		checked: boolean,
		exclusiveMode: boolean
	): Promise<void> {
		const nextTraits = nextSelectedTraits(activeTraits, key, value, checked, exclusiveMode);
		await applyTraitFilters(nextTraits, activeTraitRanges);
	}

	function bidBookTraitValueHref(trait: { key: string; value: string }): string {
		const nextTraits = nextSelectedTraits(activeTraits, trait.key, trait.value, true, false);
		return filtersHref(nextTraits, activeTraitRanges);
	}

	async function onApplyTraitRange(
		key: string,
		fromValue: string | null,
		toValue: string | null
	): Promise<void> {
		const nextRanges = setTraitRangeFilter(activeTraitRanges, key, fromValue, toValue);
		await applyTraitFilters(activeTraits, nextRanges);
	}

	function onWindowKeydown(event: KeyboardEvent): void {
		keyboardShortcutsHelp.onWindowKeydown(event);
		if (event.defaultPrevented || $keyboardShortcutsHelpState.open) return;

		const previewWasOpen = $tokenPreviewState.open;
		tokenPreview.onWindowKeydown(event);
		if (previewWasOpen) return;

		if (handleCollectionSectionShortcut(event, collectionNavigation())) {
			return;
		}

		if (
			!event.metaKey &&
			!event.ctrlKey &&
			!event.altKey &&
			!isKeyboardTextEntryTarget(event.target, { allowCheckboxAndRadio: true })
		) {
			if (event.key.toLowerCase() === 's') {
				event.preventDefault();
				void cycleBidScope();
				return;
			}
		}

		if (!showBidBookTraitFilters) return;
		traitFacetPanel.onWindowKeydown(event, {
			onToggle: onTraitPanelControlAction,
			onReset: onResetTraits
		});
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#snippet bidBookPanel()}
	<BidBookPanel
		{bidBook}
		showScope={bidScope !== 'collection'}
		view={bidScope === 'traits' ? 'trait-demand' : 'rows'}
		{showMuted}
		{basePath}
		{mediaMode}
		preferredDemandTraitKey={preferredBidBookDemandTraitKey}
		traitValueHref={bidBookTraitValueHref}
	/>
{/snippet}

<CollectionPageLayout
	navigation={collectionNavigation()}
	activeSection="bidding"
	activeBiddingView={biddingView}
	collectionAvailable={collection !== null}
	showCustomization={!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}
>
	{#snippet breadcrumbs()}
		{#if collection}
			{#if IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}
				<a href={collectionNavigation().hrefs.asks}>{collection.slug}</a>
				<span class="breadcrumbs-separator">/</span>
				<span class="breadcrumbs-current">bidding</span>
			{:else}
				<a href={collectionsHref()}>collections</a>
				<span class="breadcrumbs-separator">/</span>
				<a href={collectionNavigation().hrefs.asks}>{collection.slug}</a>
				<span class="breadcrumbs-separator">/</span>
				<span class="breadcrumbs-current">bidding</span>
			{/if}
		{/if}
	{/snippet}
	{#snippet headerActions()}
		{#if collection}
			<CollectionJumpForm chainRef={chain?.slug ?? ''} basePath={basePath} mediaMode={mediaMode} />
		{/if}
		<KeyboardShortcutsHelp {keyboardShortcutsHelp} />
	{/snippet}
	{#snippet topActions()}
		{#if collection}
			{#if biddingView === 'bid_book'}
				<div class="panel-top-actions-row">
					<div class="secondary-tabs" aria-label="Bid scope filter">
						{#if bidScope === 'collection'}
							<button type="button" class="secondary-tab-active" disabled>collection</button>
						{:else}
							<a href={bidScopeHref('collection')}>collection</a>
						{/if}
						{#if bidScope === 'traits'}
							<button type="button" class="secondary-tab-active" disabled>traits</button>
						{:else}
							<a href={bidScopeHref('traits')}>traits</a>
						{/if}
					</div>
				</div>
				{#if bidScope === 'traits'}
					<div class="panel-top-actions-row">
						<TraitFacetPanelControls
							hasActiveFilters={hasActiveTraitFilters}
							collapsed={$traitFacetPanelState.collapsed}
							onToggleCollapsed={traitFacetPanel.toggle}
							filterModes={biddingTraitFilterModes}
							selectedFilterMode={traitJoinMode}
							onFilterModeChange={onTraitJoinModeChange}
							onReset={onResetTraits}
							selectedTraits={activeTraits}
							selectedRanges={activeTraitRanges}
							onSelectedFiltersChange={applyTraitFilters}
						/>
					</div>
				{/if}
			{/if}
		{/if}
	{/snippet}

	{#if biddingView === 'bid_book'}
		{#if bidScope === 'traits'}
			<div class="detail-layout" class:sidebar-collapsed={$traitFacetPanelState.collapsed}>
				<TraitFacetPanel
					{facets}
					selectedTraits={activeTraits}
					selectedRanges={activeTraitRanges}
					collapsed={$traitFacetPanelState.collapsed}
					onToggleTrait={onTraitToggleWithMode}
					onApplyTraitRange={onApplyTraitRange}
				/>

				<div class="token-panel bidding-panel-main">
					{@render bidBookPanel()}
				</div>
			</div>
		{:else}
			<div class="token-panel bidding-panel-main">
				{@render bidBookPanel()}
			</div>
		{/if}
	{:else}
		<div class="token-panel bidding-panel-main bidding-jobs-panel">
			<section class="runtime-section bid-book-summary-panel">
				<div class="runtime-kv-grid bid-book-meta">
					<div>
						<span class="runtime-k">jobs</span>
						<span class="runtime-v">{collectionJobs.length}</span>
					</div>
					<div>
						<span class="runtime-k">token jobs</span>
						<span class="runtime-v">{tokenJobCount}</span>
					</div>
					<div>
						<span class="runtime-k">other scopes</span>
						<span class="runtime-v">{nonTokenJobCount}</span>
					</div>
				</div>
			</section>

			{#if collectionJobs.length === 0}
				<section class="bid-book-table-panel">
					<p class="muted bid-book-empty">no jobs</p>
				</section>
			{:else}
				<div class="table-wrap">
					<table class="bidding-jobs-table">
						<thead>
							<tr>
								<th>image</th>
								<th>target</th>
								<th>status</th>
								<th>floor</th>
								<th>ceiling</th>
								<th>delta</th>
								<th>runtime</th>
								<th>actions</th>
							</tr>
						</thead>
						<tbody>
							{#each collectionJobs as job (job.jobId)}
								{@const tokenId = jobTokenId(job)}
								<CollectionBiddingJobRow
									chainRef={chain?.slug ?? ''}
									collectionRef={collection?.slug ?? ''}
									collectionBasePath={basePath}
									returnPath={biddingPath()}
									returnQuery={biddingReturnQuery()}
									{mediaMode}
									{job}
									onJobUpdated={handleJobUpdated}
									onJobArchived={handleJobArchived}
								>
									{#snippet imageCell()}
										{#if tokenId}
											<ActivityTokenCell
												chainRef={chain?.slug ?? null}
												collectionRef={collection?.slug ?? null}
												{tokenId}
												token={jobTokenSummary(job)}
												selectedMediaMode={media.selectedMode}
												availableMediaModes={media.availableModes}
												tokenPreview={tokenPreview}
											/>
										{:else}
											<span class="muted">-</span>
										{/if}
									{/snippet}
								</CollectionBiddingJobRow>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	{/if}
</CollectionPageLayout>
