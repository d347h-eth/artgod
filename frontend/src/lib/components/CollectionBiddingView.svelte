<script lang="ts">
	import { goto } from '$app/navigation';
	import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
	import type {
		ApiBiddingBidBook,
		ApiBiddingJob,
		ApiChain,
		ApiCollection,
		ApiCollectionBiddingBidScopeFilter,
		ApiTokenAttribute,
		ApiTraitFacet,
		ApiTraitRangeFilter
	} from '$lib/api-types';
	import { buildCollectionActivityHref } from '$lib/activity-query';
	import {
		buildCollectionBiddingHref,
		buildCollectionBiddingQuery,
		type CollectionBiddingViewMode
	} from '$lib/bidding-query';
	import BidBookPanel from '$lib/components/BidBookPanel.svelte';
	import CollectionJumpForm from '$lib/components/CollectionJumpForm.svelte';
	import CollectionPageLayout from '$lib/components/CollectionPageLayout.svelte';
	import KeyboardShortcutsHelp from '$lib/components/KeyboardShortcutsHelp.svelte';
	import { createKeyboardShortcutsHelpController } from '$lib/components/keyboard-shortcuts-help-controller';
	import CollectionBiddingJobRow from '$lib/components/CollectionBiddingJobRow.svelte';
	import TraitFacetPanel from '$lib/components/TraitFacetPanel.svelte';
	import TraitFacetPanelControls from '$lib/components/TraitFacetPanelControls.svelte';
	import { createTraitFacetPanelController } from '$lib/components/trait-facet-panel-controller';
	import { buildCollectionCustomizationHref } from '$lib/customization-query';
	import { appendMediaModeParam } from '$lib/media-mode';
	import { joinPath, withQuery } from '$lib/route-paths';
	import {
		IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
		publicCollectionTokensPath
	} from '$lib/runtime/public-deployment';
	import { nextSelectedTraits, setTraitRangeFilter } from '$lib/trait-filters';
	import { buildTokenBrowserHref } from '$lib/token-browser-query';

	let {
		chain,
		collection,
		jobs,
		bidBook,
		facets,
		basePath,
		selectedTraits,
		selectedTraitRanges,
		bidScope,
		biddingView = 'bid_book',
		showMuted = false,
		mediaMode
	}: {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		jobs: ApiBiddingJob[];
		bidBook: ApiBiddingBidBook;
		facets: ApiTraitFacet[];
		basePath: string;
		selectedTraits: ApiTokenAttribute[];
		selectedTraitRanges: ApiTraitRangeFilter[];
		bidScope: ApiCollectionBiddingBidScopeFilter;
		biddingView: CollectionBiddingViewMode;
		showMuted?: boolean;
		mediaMode: string | null;
	} = $props();

	const keyboardShortcutsHelp = createKeyboardShortcutsHelpController();
	const traitFacetPanel = createTraitFacetPanelController();
	const traitFacetPanelState = traitFacetPanel.state;
	let collectionJobs = $state<ApiBiddingJob[]>(jobs);
	let activeTraits = $state<ApiTokenAttribute[]>(selectedTraits);
	let activeTraitRanges = $state<ApiTraitRangeFilter[]>(selectedTraitRanges);

	const tokenJobCount = $derived(
		collectionJobs.filter((job) => job.target.type === 'token').length
	);
	const nonTokenJobCount = $derived(collectionJobs.length - tokenJobCount);

	$effect(() => {
		collectionJobs = jobs;
	});

	$effect(() => {
		activeTraits = selectedTraits;
	});

	$effect(() => {
		activeTraitRanges = selectedTraitRanges;
	});

	function collectionsHref(): string {
		if (IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) return publicCollectionTokensPath();
		if (!chain) return '/';
		return `/${chain.slug}`;
	}

	function tokensHref(): string {
		return buildTokenBrowserHref({
			basePath,
			limit: DEFAULT_PAGE_LIMIT,
			displayMode: 'grid',
			tokenStatus: 'listed',
			selectedTraits,
			selectedTraitRanges,
			mediaMode
		});
	}

	function activitiesHref(): string {
		return buildCollectionActivityHref({
			basePath,
			limit: DEFAULT_PAGE_LIMIT,
			kind: 'sales',
			selectedTraits,
			selectedTraitRanges,
			mediaMode
		});
	}

	function holdersHref(): string {
		const query = new URLSearchParams();
		appendMediaModeParam(query, mediaMode);
		return withQuery(joinPath(basePath, 'holders'), query);
	}

	function customizationHref(): string {
		return buildCollectionCustomizationHref({
			basePath,
			selectedTraits,
			selectedTraitRanges,
			mediaMode
		});
	}

	function biddingHref(): string {
		return buildCollectionBiddingHref({
			basePath,
			selectedTraits,
			selectedTraitRanges,
			viewMode: biddingView,
			mediaMode,
			showMuted
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
			viewMode: biddingView,
			mediaMode,
			showMuted
		});
	}

	function bidScopeHref(nextBidScope: ApiCollectionBiddingBidScopeFilter): string {
		return buildCollectionBiddingHref({
			basePath,
			selectedTraits,
			selectedTraitRanges,
			bidScope: nextBidScope,
			viewMode: 'bid_book',
			mediaMode,
			showMuted
		});
	}

	function biddingViewHref(nextView: CollectionBiddingViewMode): string {
		return buildCollectionBiddingHref({
			basePath,
			selectedTraits,
			selectedTraitRanges,
			bidScope,
			viewMode: nextView,
			mediaMode,
			showMuted
		});
	}

	function resetTraitsHref(): string {
		return filtersHref([], []);
	}

	function biddingPath(): string {
		return joinPath(basePath, 'bidding');
	}

	function biddingReturnQuery(): string {
		return buildCollectionBiddingQuery({
			selectedTraits,
			selectedTraitRanges,
			bidScope,
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

	async function onResetTraits(): Promise<void> {
		await goto(resetTraitsHref(), {
			invalidateAll: true,
			keepFocus: true,
			noScroll: true
		});
	}

	async function onTraitToggleWithMode(
		key: string,
		value: string,
		checked: boolean,
		exclusiveMode: boolean
	): Promise<void> {
		const nextTraits = nextSelectedTraits(activeTraits, key, value, checked, exclusiveMode);
		activeTraits = nextTraits;
		await goto(filtersHref(nextTraits, activeTraitRanges), {
			invalidateAll: true,
			keepFocus: true,
			noScroll: true
		});
	}

	async function onApplyTraitRange(
		key: string,
		fromValue: string | null,
		toValue: string | null
	): Promise<void> {
		const nextRanges = setTraitRangeFilter(activeTraitRanges, key, fromValue, toValue);
		activeTraitRanges = nextRanges;
		await goto(filtersHref(activeTraits, nextRanges), {
			invalidateAll: true,
			keepFocus: true,
			noScroll: true
		});
	}

	function onWindowKeydown(event: KeyboardEvent): void {
		keyboardShortcutsHelp.onWindowKeydown(event);
		if (event.defaultPrevented) return;
		if (biddingView !== 'bid_book') return;
		traitFacetPanel.onWindowKeydown(event, {
			onReset: onResetTraits
		});
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

<CollectionPageLayout
	tokensHref={tokensHref()}
	activitiesHref={activitiesHref()}
	holdersHref={holdersHref()}
	customizationHref={customizationHref()}
	biddingHref={biddingHref()}
	activeSection="bidding"
	collectionAvailable={collection !== null}
	showCustomization={!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}
	showBidding={!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}
>
	{#snippet breadcrumbs()}
		{#if collection}
			{#if IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}
				<a href={tokensHref()}>{collection.slug}</a>
				<span class="breadcrumbs-separator">/</span>
				<span class="breadcrumbs-current">bidding</span>
			{:else}
				<a href={collectionsHref()}>collections</a>
				<span class="breadcrumbs-separator">/</span>
				<a href={tokensHref()}>{collection.slug}</a>
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
			<div class="panel-top-actions-row">
				<div class="secondary-tabs" aria-label="Bidding view">
					{#if biddingView === 'bid_book'}
						<span class="secondary-tab-active">bid book</span>
					{:else}
						<a href={biddingViewHref('bid_book')}>bid book</a>
					{/if}
					{#if biddingView === 'jobs'}
						<span class="secondary-tab-active">jobs</span>
					{:else}
						<a href={biddingViewHref('jobs')}>jobs</a>
					{/if}
				</div>
			</div>
			{#if biddingView === 'bid_book'}
				<div class="panel-top-actions-row">
					<div class="secondary-tabs" aria-label="Bid scope filter">
						{#if bidScope === 'collection'}
							<span class="secondary-tab-active">collection</span>
						{:else}
							<a href={bidScopeHref('collection')}>collection</a>
						{/if}
						{#if bidScope === 'traits'}
							<span class="secondary-tab-active">traits</span>
						{:else}
							<a href={bidScopeHref('traits')}>traits</a>
						{/if}
					</div>
				</div>
				<div class="panel-top-actions-row">
					<TraitFacetPanelControls
						hasActiveFilters={activeTraits.length > 0 || activeTraitRanges.length > 0}
						collapsed={$traitFacetPanelState.collapsed}
						onToggleCollapsed={traitFacetPanel.toggle}
						onReset={onResetTraits}
					/>
				</div>
			{/if}
		{/if}
	{/snippet}

	{#if biddingView === 'bid_book'}
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
				<BidBookPanel
					{bidBook}
					showScope={bidScope !== 'collection'}
					view={bidScope === 'traits' ? 'trait-demand' : 'rows'}
					{showMuted}
					{basePath}
					{mediaMode}
				/>
			</div>
		</div>
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
								/>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	{/if}
</CollectionPageLayout>
