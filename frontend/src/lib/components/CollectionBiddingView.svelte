<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
	import {
		TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND,
		TRADING_JOB_TARGET_KIND
	} from '@artgod/shared/types';
	import type {
		ApiBiddingBidBook,
		ApiBiddingBidBookRow,
		ApiBiddingCollectionSettings,
		ApiBiddingTokenOfferCard,
		ApiBiddingTokenOfferCardsPage,
		ApiBiddingJob,
		ApiBiddingPriceTier,
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
		COLLECTION_BIDDING_BID_SCOPE_FILTER,
		COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
		COLLECTION_BIDDING_VIEW_MODE,
		buildCollectionBiddingHref,
		buildCollectionBiddingQuery,
		nextCollectionBiddingBidScopeFilter,
		type CollectionBiddingViewMode
	} from '$lib/bidding-query';
	import {
		bidBookRefreshPaceLabel,
		bidBookRefreshPaceTitle,
		formatBidBookFreshness
	} from '$lib/bidding-bid-book-source';
	import { resolveBiddingTokenActionLabel } from '$lib/bidding-selection-actions';
	import { bidBookPriceEffectiveWei } from '$lib/bidding-bid-book-price';
	import { ownBidStatusBadges, type BidBookOwnStatusBadge } from '$lib/bidding-bid-book-own-status';
	import { writeCollectionBiddingNavigationPreference } from '$lib/bidding-navigation-preferences';
	import { emptyBiddingTokenOfferCardsPage } from '$lib/bidding-empty-state';
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
	import {
		BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE,
		buildBiddingAutomationTokenFilterSnapshot,
		buildBiddingAutomationDraftFromSelection,
		buildBiddingAutomationDraftFromBid,
		biddingTraitCriteriaToTokenAttributes,
		canDraftTraitJobFromFilters,
		type BiddingAutomationTokenFilterSnapshot
	} from '$lib/bidding-automation';
	import {
		buildCollectionNavigation,
		handleCollectionSectionShortcut
	} from '$lib/collection-navigation';
	import ActivityTokenCell from '$lib/components/ActivityTokenCell.svelte';
	import BidBookPanel from '$lib/components/BidBookPanel.svelte';
	import BiddingAutomationPanel from '$lib/components/BiddingAutomationPanel.svelte';
	import BiddingPriceTierPanel from '$lib/components/BiddingPriceTierPanel.svelte';
	import BiddingSelectionControls from '$lib/components/BiddingSelectionControls.svelte';
	import BidBookMakerFilterControl from '$lib/components/BidBookMakerFilterControl.svelte';
	import CollectionJumpForm from '$lib/components/CollectionJumpForm.svelte';
	import CollectionPageLayout from '$lib/components/CollectionPageLayout.svelte';
	import CursorPaginationControls from '$lib/components/CursorPaginationControls.svelte';
	import KeyboardShortcutsHelp from '$lib/components/KeyboardShortcutsHelp.svelte';
	import { createKeyboardShortcutsHelpController } from '$lib/components/keyboard-shortcuts-help-controller';
	import { isKeyboardTextEntryTarget } from '$lib/components/keyboard-targets';
	import {
		buildPaginationWindowSignature,
		describePaginationWindow,
		pageToPaginationWindow,
		readPaginationWindow,
		resolvePaginationWindow,
		traitFilterPaginationSignatureParts,
		writePaginationWindow
	} from '$lib/components/pagination-window';
	import CollectionBiddingJobRow from '$lib/components/CollectionBiddingJobRow.svelte';
	import TokenCardTile from '$lib/components/TokenCardTile.svelte';
	import {
		buildAskMarketPrice,
		buildBidMarketPrice,
		type MarketPriceItem
	} from '$lib/market-price';
	import { getTokenPreviewController } from '$lib/components/token-preview-controller';
	import TraitFacetPanel from '$lib/components/TraitFacetPanel.svelte';
	import TraitFacetPanelControls from '$lib/components/TraitFacetPanelControls.svelte';
	import { openseaItemHref as buildOpenseaItemHref } from '$lib/marketplace-links';
	import {
		runTraitFacetPanelControlAction,
		type TraitFacetFilterModeOption
	} from '$lib/components/trait-facet-panel-control-action';
	import { createTraitFacetPanelController } from '$lib/components/trait-facet-panel-controller';
	import { joinPath, withQuery } from '$lib/route-paths';
	import { buildTokenDetailHref } from '$lib/token-browser-query';
	import {
		collectionBiddingNavigationVisibilityForDeployment,
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
		biddingSettings,
		priceTiers = [],
		bidBook,
		tokenOfferCards = emptyBiddingTokenOfferCardsPage(),
		facets,
		media,
		included,
		basePath,
		selectedTraits,
		selectedTraitRanges,
		bidScope,
		traitJoinMode,
		biddingView = COLLECTION_BIDDING_VIEW_MODE.BidBook,
		showMuted = false,
		makerFilter = null,
		mediaMode,
		requestCursor = null
	}: {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		jobs: ApiBiddingJob[];
		biddingSettings: ApiBiddingCollectionSettings;
		priceTiers?: ApiBiddingPriceTier[];
		bidBook: ApiBiddingBidBook;
		tokenOfferCards?: ApiBiddingTokenOfferCardsPage;
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
		makerFilter?: string | null;
		mediaMode: string | null;
		requestCursor?: string | null;
	} = $props();

	const tokenPreview = getTokenPreviewController();
	const tokenPreviewState = tokenPreview.state;
	const biddingAutomation = createBiddingAutomationController();
	const biddingAutomationState = biddingAutomation.state;
	const keyboardShortcutsHelp = createKeyboardShortcutsHelpController();
	const keyboardShortcutsHelpState = keyboardShortcutsHelp.state;
	const traitFacetPanel = createTraitFacetPanelController();
	const traitFacetPanelState = traitFacetPanel.state;
	const biddingTraitFilterModes: TraitFacetFilterModeOption[] = [
		{
			value: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
			label: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or
		},
		{
			value: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And,
			label: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And
		}
	];
	let collectionJobs = $state<ApiBiddingJob[]>(jobs);
	let activeBiddingSettings = $state<ApiBiddingCollectionSettings>(biddingSettings);
	let activePriceTiers = $state<ApiBiddingPriceTier[]>(priceTiers);
	let activeTraits = $state<ApiTokenAttribute[]>(selectedTraits);
	let activeTraitRanges = $state<ApiTraitRangeFilter[]>(selectedTraitRanges);
	let visibleTokenOfferCards = $state<ApiBiddingTokenOfferCard[]>(tokenOfferCards.items);
	let tokenOffersRangeStart = $state(tokenOfferCards.rangeStart);
	let tokenOffersRangeEnd = $state(tokenOfferCards.rangeEnd);
	let tokenOffersPagesLoaded = $state(tokenOfferCards.items.length === 0 ? 0 : 1);
	let tokenOffersHeadPrevCursor = $state<string | null>(tokenOfferCards.prevCursor);
	let tokenOffersTailNextCursor = $state<string | null>(tokenOfferCards.nextCursor);
	let tokenOffersPagingPending = $state(false);
	let lastBiddingFilterKey = $state('');
	let biddingPanelExpandSignal = $state(0);
	let priceTierPanelOpen = $state(false);

	const tokenJobCount = $derived(
		collectionJobs.filter((job) => job.target.type === TRADING_JOB_TARGET_KIND.Token).length
	);
	const nonTokenJobCount = $derived(collectionJobs.length - tokenJobCount);
	const hasActiveTraitFilters = $derived(activeTraits.length > 0 || activeTraitRanges.length > 0);
	const showBidBookFilters = $derived(
		biddingView === COLLECTION_BIDDING_VIEW_MODE.BidBook &&
			(bidScope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token ||
				bidScope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits)
	);
	const showBidBookTraitJoinControls = $derived(
		biddingView === COLLECTION_BIDDING_VIEW_MODE.BidBook &&
			bidScope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits
	);
	const preferredBidBookDemandTraitKey = $derived(
		bidScope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits &&
			traitJoinMode === COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or &&
			hasActiveTraitFilters
			? (activeTraits[0]?.key ?? activeTraitRanges[0]?.key ?? null)
			: null
	);
	const tokenOfferMetrics = $derived(
		describePaginationWindow({
			totalItems: tokenOfferCards.totalItems,
			rangeStart: tokenOffersRangeStart,
			rangeEnd: tokenOffersRangeEnd,
			limit: tokenOfferCards.limit,
			tailNextCursor: tokenOffersTailNextCursor
		})
	);
	const visibleTokenOfferCardIds = $derived(visibleTokenOfferCards.map((token) => token.tokenId));
	const currentBiddingSelection = $derived($biddingAutomationState.selection);
	const selectionBiddingDraft = $derived(
		currentBiddingSelection ? buildBiddingAutomationDraftFromSelection(currentBiddingSelection) : null
	);
	const selectedBiddingDraft = $derived(selectionBiddingDraft);
	const biddingAutomationPanelOpen = $derived(selectedBiddingDraft !== null);
	const biddingSelectionStateKey = $derived(
		biddingAutomationSelectionStateKey(currentBiddingSelection)
	);
	const biddingSelectionSummary = $derived(
		describeBiddingAutomationSelection(currentBiddingSelection)
	);
	const ownMakerAddress = $derived(bidBook.ownMakerAddress);
	const biddingFilterKey = $derived(activeBiddingFilterKey());
	const canBidOnTraits = $derived(
		canDraftTraitJobFromFilters({
			selectedTraits: activeTraits,
			selectedTraitRanges: activeTraitRanges
		})
	);
	const canRefineTokenSelectionToVisiblePage = $derived(tokenOfferCards.totalPages > 1);
	const tokenActionLabel = $derived(
		resolveBiddingTokenActionLabel({
			allFilteredSelectionActive: isAllFilteredTokenSelectionActive(),
			canRefineTokenSelectionToVisiblePage
		})
	);

	$effect(() => {
		collectionJobs = jobs;
	});

	$effect(() => {
		activeBiddingSettings = biddingSettings;
	});

	$effect(() => {
		activePriceTiers = priceTiers;
	});

	$effect(() => {
		activeTraits = selectedTraits;
	});

	$effect(() => {
		activeTraitRanges = selectedTraitRanges;
	});

	$effect(() => {
		if (bidScope !== COLLECTION_BIDDING_BID_SCOPE_FILTER.Token) {
			tokenOffersPagingPending = false;
			return;
		}

		const signature = tokenOfferWindowSignature();
		const incoming = pageToPaginationWindow(tokenOfferCards);
		const cached = browser ? readPaginationWindow<ApiBiddingTokenOfferCard>(signature) : null;
		const resolved = resolvePaginationWindow({
			cached,
			incoming,
			requestCursor,
			itemKey: (token) => token.tokenId
		});

		visibleTokenOfferCards = resolved.items;
		tokenOffersRangeStart = resolved.rangeStart;
		tokenOffersRangeEnd = resolved.rangeEnd;
		tokenOffersPagesLoaded = resolved.pagesLoaded;
		tokenOffersHeadPrevCursor = resolved.headPrevCursor;
		tokenOffersTailNextCursor = resolved.tailNextCursor;

		if (browser) {
			writePaginationWindow(signature, resolved);
		}

		tokenOffersPagingPending = false;
	});

	$effect(() => {
		writeCollectionBiddingNavigationPreference({ bidScope });
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
		clearBiddingSelection();
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
			activityEventFeeds: collection?.activityEventFeeds ?? [],
			bidding: {
				...collectionBiddingNavigationVisibilityForDeployment(),
				bidScope,
				traitJoinMode,
				viewMode: biddingView,
				maker: makerFilter,
				showMuted
			}
		});
	}

	function filtersHref(
		traits: ApiTokenAttribute[],
		ranges: ApiTraitRangeFilter[],
		nextTraitJoinMode: ApiCollectionBiddingTraitFilterJoinMode = traitJoinMode
	): string {
		return buildCollectionBiddingHref({
			basePath,
			selectedTraits: traits,
			selectedTraitRanges: ranges,
			bidScope,
			traitJoinMode: nextTraitJoinMode,
			viewMode: biddingView,
			mediaMode,
			maker: makerFilter,
			showMuted
		});
	}

	function bidScopeHref(
		nextBidScope: ApiCollectionBiddingBidScopeFilter,
		nextView: CollectionBiddingViewMode = COLLECTION_BIDDING_VIEW_MODE.BidBook
	): string {
		const query = buildCollectionBiddingQuery({
			selectedTraits: activeTraits,
			selectedTraitRanges: activeTraitRanges,
			bidScope: nextBidScope,
			traitJoinMode,
			viewMode: nextView,
			mediaMode,
			maker: makerFilter,
			showMuted
		});
		// Keep clicked scopes explicit so stored preferences cannot override a scope change.
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
			maker: makerFilter,
			showMuted
		});
	}

	function biddingPath(): string {
		return joinPath(basePath, 'bidding');
	}

	function biddingReturnQuery(): string {
		const query = buildCollectionBiddingQuery({
			selectedTraits: activeTraits,
			selectedTraitRanges: activeTraitRanges,
			bidScope,
			traitJoinMode,
			viewMode: biddingView,
			mediaMode,
			maker: makerFilter,
			showMuted
		});
		if (bidScope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token) {
			query.set(BID_SCOPE_QUERY_PARAM, COLLECTION_BIDDING_BID_SCOPE_FILTER.Token);
		}
		return query.toString();
	}

	function tokenOfferCardHref(tokenId: string): string {
		return buildTokenDetailHref({
			basePath,
			tokenId,
			mediaMode,
			returnPath: biddingPath(),
			returnQuery: biddingReturnQuery()
		});
	}

	function tokenOfferCardsHref(cursor: string | null): string {
		const query = buildCollectionBiddingQuery({
			selectedTraits: activeTraits,
			selectedTraitRanges: activeTraitRanges,
			bidScope: COLLECTION_BIDDING_BID_SCOPE_FILTER.Token,
			viewMode: biddingView,
			mediaMode,
			maker: makerFilter,
			limit: tokenOfferCards.limit,
			cursor
		});
		// Keep token scope explicit on pagination so stored preferences cannot redirect away.
		query.set(BID_SCOPE_QUERY_PARAM, COLLECTION_BIDDING_BID_SCOPE_FILTER.Token);
		return withQuery(biddingPath(), query);
	}

	function loadPreviousTokenOffersHref(): string {
		if (!tokenOfferMetrics.hasPreviousPage) return '#';
		return tokenOfferCardsHref(tokenOffersHeadPrevCursor);
	}

	function loadNextTokenOffersHref(): string {
		if (!tokenOffersTailNextCursor) return '#';
		return tokenOfferCardsHref(tokenOffersTailNextCursor);
	}

	function tokenOfferWindowSignature(): string {
		return buildPaginationWindowSignature([
			basePath,
			'token-offers',
			tokenOfferCards.limit,
			bidBook.state.source,
			media.selectedMode,
			makerFilter ?? 'all-makers',
			showMuted ? 'show-muted' : 'hide-muted',
			...traitFilterPaginationSignatureParts({ traits: activeTraits, ranges: activeTraitRanges })
		]);
	}

	function handleJobsChanged(nextJobs: ApiBiddingJob[]): void {
		const nextById = new Map(nextJobs.map((job) => [job.jobId, job]));
		const archivedIds = new Set(
			nextJobs.filter((job) => job.status === 'archived').map((job) => job.jobId)
		);
		const merged = collectionJobs
			.filter((job) => !archivedIds.has(job.jobId))
			.map((job) => nextById.get(job.jobId) ?? job)
			.filter((job) => job.status !== 'archived');
		const existing = new Set(collectionJobs.map((job) => job.jobId));
		for (const job of nextJobs) {
			if (job.status !== 'archived' && !existing.has(job.jobId)) {
				merged.unshift(job);
			}
		}
		collectionJobs = merged;
	}

	function handlePriceTiersChanged(nextTiers: ApiBiddingPriceTier[]): void {
		activePriceTiers = nextTiers;
	}

	function handleBiddingSettingsChanged(nextSettings: ApiBiddingCollectionSettings): void {
		activeBiddingSettings = nextSettings;
	}

	function togglePriceTierPanel(): void {
		priceTierPanelOpen = !priceTierPanelOpen;
	}

	function jobTokenId(job: ApiBiddingJob): string | null {
		return job.target.type === TRADING_JOB_TARGET_KIND.Token ? job.target.tokenId : null;
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
			maker: makerFilter,
			showMuted
		});
	}

	function makerFilterHref(makerAddress: string | null): string {
		const query = buildCollectionBiddingQuery({
			selectedTraits: activeTraits,
			selectedTraitRanges: activeTraitRanges,
			bidScope,
			traitJoinMode,
			viewMode: biddingView,
			mediaMode,
			maker: makerAddress,
			showMuted
		});
		if (bidScope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token) {
			query.set(BID_SCOPE_QUERY_PARAM, COLLECTION_BIDDING_BID_SCOPE_FILTER.Token);
		}
		return withQuery(biddingPath(), query);
	}

	function isShowingOwnMakerBids(): boolean {
		return (
			!!makerFilter &&
			!!ownMakerAddress &&
			makerFilter.toLowerCase() === ownMakerAddress.toLowerCase()
		);
	}

	async function onMakerFilterApply(makerAddress: string): Promise<void> {
		await goto(makerFilterHref(makerAddress), {
			invalidateAll: true,
			keepFocus: true,
			noScroll: true
		});
	}

	async function onMakerFilterClear(): Promise<void> {
		await goto(makerFilterHref(null), {
			invalidateAll: true,
			keepFocus: true,
			noScroll: true
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
		if (!showBidBookTraitJoinControls) {
			await traitFacetPanel.toggle();
			return;
		}
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
		nextRanges: ApiTraitRangeFilter[],
		nextTraitJoinMode: ApiCollectionBiddingTraitFilterJoinMode = traitJoinMode
	): Promise<void> {
		activeTraits = nextTraits;
		activeTraitRanges = nextRanges;
		await goto(filtersHref(nextTraits, nextRanges, nextTraitJoinMode), {
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

	function resolveAdjacentOfferTokenId(step: -1 | 1, currentTokenId: string): string | null {
		const currentIndex = visibleTokenOfferCards.findIndex((token) => token.tokenId === currentTokenId);
		if (currentIndex === -1) {
			return null;
		}
		return visibleTokenOfferCards[currentIndex + step]?.tokenId ?? null;
	}

	function tokenOfferMarketPrices(card: ApiBiddingTokenOfferCard): MarketPriceItem[] {
		const prices: MarketPriceItem[] = [];
		const ask = buildAskMarketPrice({
			rawPrice: card.listingPrice,
			currencyAddress: card.listingCurrency,
			href: openseaItemHref(card),
			title: 'ask'
		});
		if (ask) {
			prices.push(ask);
		}

		const topOffer = card.offers[0];
		if (topOffer) {
			const bid = buildBidMarketPrice({
				rawPrice: bidBookPriceEffectiveWei(topOffer.price),
				currencyAddress: topOffer.currencyAddress,
				currencySymbol: topOffer.currencySymbol,
				title: 'offer'
			});
			if (bid) prices.push(bid);
		}
		return prices;
	}

	function openseaItemHref(token: ApiBiddingTokenOfferCard): string | null {
		return buildOpenseaItemHref({
			chainSlug: chain?.slug ?? null,
			collectionAddress: collection?.address ?? null,
			tokenId: token.tokenId
		});
	}

	function tokenOfferMetaLabel(card: ApiBiddingTokenOfferCard): string {
		const count = card.offers.length;
		return count === 1 ? '1 offer' : `${count} offers`;
	}

	function tokenOfferOwnStatusBadges(card: ApiBiddingTokenOfferCard): BidBookOwnStatusBadge[] {
		const badges = new Map<string, BidBookOwnStatusBadge>();
		for (const offer of card.offers) {
			for (const badge of ownBidStatusBadges(offer)) {
				badges.set(`${badge.kind}:${badge.label}`, badge);
			}
		}
		return [...badges.values()];
	}

	function tokenOffersResultsSummary(): string {
		const count = tokenOfferCards.totalItems;
		return count === 1 ? '1 token' : `${count} tokens`;
	}

	function bidOnFilteredTraits(): void {
		if (!canBidOnTraits) return;
		biddingAutomation.selectFilteredTokens(
			buildFilteredTraitBiddingSelectionInput({
				tokenCount: tokenOfferCards.totalItems,
				filter: currentBiddingFilterSnapshot()
			})
		);
		expandBiddingAutomationPanel();
	}

	function bidOnFilteredTokenOffers(): void {
		if (isAllFilteredTokenSelectionActive()) {
			if (canRefineTokenSelectionToVisiblePage) {
				biddingAutomation.selectExplicitTokens(visibleTokenOfferCardIds);
			}
			expandBiddingAutomationPanel();
			return;
		}
		biddingAutomation.selectFilteredTokens(
			buildFilteredTokenBatchBiddingSelectionInput({
				tokenCount: tokenOfferCards.totalItems,
				filter: currentBiddingFilterSnapshot()
			})
		);
		expandBiddingAutomationPanel();
	}

	function toggleVisibleTokenSelection(request: Omit<ToggleBiddingTokenInput, 'visibleTokenIds'>): void {
		biddingAutomation.toggleToken({
			...request,
			visibleTokenIds: visibleTokenOfferCardIds
		});
	}

	function biddingTokenSelectionState(tokenId: string, stateKey: string) {
		return biddingAutomationTokenSelectionState(currentBiddingSelection, tokenId, stateKey);
	}

	function isAllFilteredTokenSelectionActive(): boolean {
		return isCleanFilteredTokenBatchSelection(currentBiddingSelection);
	}

	function currentBiddingFilterSnapshot(params: {
		traits?: ApiTokenAttribute[];
		ranges?: ApiTraitRangeFilter[];
		nextTraitJoinMode?: ApiCollectionBiddingTraitFilterJoinMode;
	} = {}): BiddingAutomationTokenFilterSnapshot {
		return buildBiddingAutomationTokenFilterSnapshot({
			source: BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE.TokenOffers,
			selectedTraits: params.traits ?? activeTraits,
			selectedTraitRanges: params.ranges ?? activeTraitRanges,
			traitJoinMode: params.nextTraitJoinMode ?? traitJoinMode,
			tokenStatus: null,
			makerAddress: makerFilter
		});
	}

	function activeBiddingFilterKey(): string {
		return JSON.stringify({
			bidScope,
			traitJoinMode,
			makerFilter,
			activeTraits,
			activeTraitRanges
		});
	}

	function onBidBookSelectBid(bid: ApiBiddingBidBookRow): void {
		const existingJob =
			bid.materialization.kind ===
			TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent
				? collectionJobs.find((job) => job.jobId === bid.materialization.jobId) ?? null
				: null;
		if (!buildBiddingAutomationDraftFromBid(bid, existingJob)) return;
		biddingAutomation.selectBid({ bid, existingJob });
		expandBiddingAutomationPanel();
	}

	async function onBidBookTraitDemandBid(selection: {
		bid: ApiBiddingBidBookRow;
		traits: ApiBiddingBidBookRow['scope']['traits'];
	}): Promise<void> {
		const nextTraits = biddingTraitCriteriaToTokenAttributes(selection.traits);
		if (!canDraftTraitJobFromFilters({ selectedTraits: nextTraits, selectedTraitRanges: [] })) {
			onBidBookSelectBid(selection.bid);
			return;
		}

		if (!buildBiddingAutomationDraftFromBid(selection.bid)) return;
		biddingAutomation.selectBid({ bid: selection.bid });
		expandBiddingAutomationPanel();
	}

	async function onBidBookTraitDemandFilter(selection: {
		traits: ApiBiddingBidBookRow['scope']['traits'];
	}): Promise<void> {
		const nextTraits = biddingTraitCriteriaToTokenAttributes(selection.traits);
		const nextTraitJoinMode = COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or;
		await applyTraitFilters(nextTraits, [], nextTraitJoinMode);
	}

	function placeCollectionBid(): void {
		const topBid = bidBook.bids[0];
		if (!topBid) return;
		onBidBookSelectBid(topBid);
	}

	function closeBiddingAutomationPanel(): void {
		biddingAutomation.clearSelection();
	}

	function clearBiddingSelection(): void {
		biddingAutomation.clearSelection();
	}

	function expandBiddingAutomationPanel(): void {
		biddingPanelExpandSignal += 1;
	}

	async function onLoadPreviousTokenOffers(event: MouseEvent): Promise<void> {
		event.preventDefault();
		if (!tokenOfferMetrics.hasPreviousPage || tokenOffersPagingPending) return;
		tokenOffersPagingPending = true;
		await goto(loadPreviousTokenOffersHref(), {
			invalidateAll: true,
			keepFocus: true,
			noScroll: true
		});
	}

	async function onLoadNextTokenOffers(event: MouseEvent): Promise<void> {
		event.preventDefault();
		if (!tokenOffersTailNextCursor || tokenOffersPagingPending) return;
		tokenOffersPagingPending = true;
		await goto(loadNextTokenOffersHref(), {
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
			const key = event.key.toLowerCase();
			if (!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT && key === 't') {
				event.preventDefault();
				togglePriceTierPanel();
				return;
			}
			if (key === 's') {
				event.preventDefault();
				void cycleBidScope();
				return;
			}
		}

		if (!showBidBookFilters) return;
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
		showScope={bidScope !== COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection}
		view={bidScope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits ? 'trait-demand' : 'rows'}
		{showMuted}
		{basePath}
		{mediaMode}
		preferredDemandTraitKey={preferredBidBookDemandTraitKey}
		traitValueHref={bidBookTraitValueHref}
		makerFilterHref={makerFilterHref}
		onSelectTraitDemandBid={onBidBookTraitDemandBid}
		onFilterTraitDemandGroup={onBidBookTraitDemandFilter}
		onSelectBid={IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT ? null : onBidBookSelectBid}
		showRowActions={bidScope !== COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection}
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
			{#if biddingView === COLLECTION_BIDDING_VIEW_MODE.BidBook}
				<div class="panel-top-actions-row">
					<BidBookMakerFilterControl
						chainRef={chain?.slug ?? ''}
						value={makerFilter}
						onApply={onMakerFilterApply}
						onClear={onMakerFilterClear}
					/>
					{#if ownMakerAddress}
						<div class="secondary-tabs" aria-label="Own bid filter">
							{#if isShowingOwnMakerBids()}
								<button type="button" class="secondary-tab-active" disabled>my bids</button>
							{:else}
								<a href={makerFilterHref(ownMakerAddress)}>my bids</a>
							{/if}
						</div>
					{/if}
				</div>
				<div class="panel-top-actions-row">
					<span class="panel-top-actions-label">scope:</span>
					<div class="secondary-tabs" aria-label="Bid scope filter">
						{#if bidScope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token}
							<button type="button" class="secondary-tab-active" disabled>token</button>
						{:else}
							<a href={bidScopeHref(COLLECTION_BIDDING_BID_SCOPE_FILTER.Token)}>token</a>
						{/if}
						{#if bidScope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits}
							<button type="button" class="secondary-tab-active" disabled>traits</button>
						{:else}
							<a href={bidScopeHref(COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits)}>traits</a>
						{/if}
						{#if bidScope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection}
							<button type="button" class="secondary-tab-active" disabled>collection</button>
						{:else}
							<a href={bidScopeHref(COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection)}>collection</a>
						{/if}
					</div>
				</div>
				{#if showBidBookFilters}
					<div class="panel-top-actions-row">
						<TraitFacetPanelControls
							hasActiveFilters={hasActiveTraitFilters}
							collapsed={$traitFacetPanelState.collapsed}
							onToggleCollapsed={traitFacetPanel.toggle}
							filterModes={showBidBookTraitJoinControls ? biddingTraitFilterModes : []}
							selectedFilterMode={showBidBookTraitJoinControls ? traitJoinMode : null}
							onFilterModeChange={showBidBookTraitJoinControls ? onTraitJoinModeChange : null}
							onReset={onResetTraits}
							selectedTraits={activeTraits}
							selectedRanges={activeTraitRanges}
							onSelectedFiltersChange={applyTraitFilters}
						/>
					</div>
				{/if}
				{#if bidScope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token || bidScope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits}
					<div class="panel-top-actions-row">
						{#if bidScope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token || canBidOnTraits || biddingSelectionSummary}
							<BiddingSelectionControls
								summary={biddingSelectionSummary}
								showTraitAction={canBidOnTraits}
								showTokenAction={bidScope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token}
								showTierAction={!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}
								tierActionActive={priceTierPanelOpen}
								tokenActionLabel={tokenActionLabel}
								tokenActionDisabled={tokenOfferCards.totalItems === 0}
								onToggleTiers={togglePriceTierPanel}
								onBidOnTraits={bidOnFilteredTraits}
								onBidOnTokens={bidOnFilteredTokenOffers}
								onClear={clearBiddingSelection}
							/>
						{/if}
					</div>
				{:else if bidScope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection && !IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}
					<div class="panel-top-actions-row">
						<BiddingSelectionControls
							summary={biddingSelectionSummary}
							showTraitAction={false}
							showTokenAction={false}
							showCollectionAction
							showTierAction
							tierActionActive={priceTierPanelOpen}
							collectionActionDisabled={bidBook.bids.length === 0}
							onToggleTiers={togglePriceTierPanel}
							onBidOnTokens={bidOnFilteredTokenOffers}
							onBidOnCollection={placeCollectionBid}
							onClear={clearBiddingSelection}
						/>
					</div>
				{/if}
			{/if}
		{/if}
	{/snippet}

	{#if priceTierPanelOpen && collection && !IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}
		<BiddingPriceTierPanel
			{chain}
			{collection}
			settings={activeBiddingSettings}
			tiers={activePriceTiers}
			onSettingsChange={handleBiddingSettingsChanged}
			onTiersChange={handlePriceTiersChanged}
			onJobsChange={handleJobsChanged}
			onClose={togglePriceTierPanel}
		/>
	{/if}

	{#if biddingView === COLLECTION_BIDDING_VIEW_MODE.BidBook}
		{#if bidScope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token || bidScope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits}
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
					{#if bidScope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token}
						<section class="runtime-section bid-book-summary-panel">
							<div class="runtime-kv-grid bid-book-meta">
								<div>
									<span class="runtime-k">refresh pace</span>
									<span class="runtime-v" title={bidBookRefreshPaceTitle(bidBook.state.source)}>
										{bidBookRefreshPaceLabel(bidBook.state.source)}
									</span>
								</div>
								<div>
									<span class="runtime-k">tokens</span>
									<span class="runtime-v">{tokenOfferCards.totalItems}</span>
								</div>
								<div>
									<span class="runtime-k">offers</span>
									<span class="runtime-v">{tokenOfferCards.totalOffers}</span>
								</div>
								<div>
									<span class="runtime-k">updated</span>
									<span class="runtime-v mono">{formatBidBookFreshness(bidBook.state)}</span>
								</div>
							</div>
							{#if bidBook.state.lastError}
								<p class="runtime-error bid-book-error" role="alert">{bidBook.state.lastError}</p>
							{/if}
						</section>

						<section class="token-offers-panel">
							<CursorPaginationControls
								resultsSummary={tokenOffersResultsSummary()}
								totalItems={tokenOfferCards.totalItems}
								rangeStart={tokenOffersRangeStart}
								rangeEnd={tokenOffersRangeEnd}
								totalPages={tokenOfferCards.totalPages}
								visibleStartPage={tokenOfferMetrics.visibleStartPage}
								visibleEndPage={tokenOfferMetrics.visibleEndPage}
								remainingItems={tokenOfferMetrics.remainingItems}
								pagesLoaded={tokenOffersPagesLoaded}
								hasPreviousPage={tokenOfferMetrics.hasPreviousPage}
								previousHref={loadPreviousTokenOffersHref()}
								previousBusy={tokenOffersPagingPending}
								onPrevious={onLoadPreviousTokenOffers}
								hasNextPage={tokenOfferMetrics.hasNextPage}
								nextHref={loadNextTokenOffersHref()}
								nextBusy={tokenOffersPagingPending}
								onNext={onLoadNextTokenOffers}
								endLabel="end of token offers"
								footerClass="token-offers-footer"
							>
								{#if visibleTokenOfferCards.length === 0}
									<p class="muted bid-book-empty">no token offers</p>
								{:else}
									<div class="token-grid-wrap">
										<div class="token-grid">
											{#each visibleTokenOfferCards as token}
												<TokenCardTile
													{chain}
													{collection}
													token={token}
													href={tokenOfferCardHref(token.tokenId)}
													selectedMediaMode={media.selectedMode}
													availableMediaModes={media.availableModes}
													{tokenPreview}
													adjacentTokenResolver={resolveAdjacentOfferTokenId}
													marketPrices={tokenOfferMarketPrices(token)}
													metaLabel={tokenOfferMetaLabel(token)}
													ownStatusBadges={tokenOfferOwnStatusBadges(token)}
													selection={{
														state: biddingTokenSelectionState(token.tokenId, biddingSelectionStateKey),
														onToggle: toggleVisibleTokenSelection
													}}
												/>
											{/each}
										</div>
									</div>
								{/if}
							</CursorPaginationControls>
						</section>
					{:else}
						{@render bidBookPanel()}
					{/if}
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
							</tr>
						</thead>
						<tbody>
							{#each collectionJobs as job (job.jobId)}
								{@const tokenId = jobTokenId(job)}
								<CollectionBiddingJobRow
									chainRef={chain?.slug ?? ''}
									collectionBasePath={basePath}
									returnPath={biddingPath()}
									returnQuery={biddingReturnQuery()}
									{mediaMode}
									{job}
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
	{#if !IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT && collection}
		<BiddingAutomationPanel
			open={biddingAutomationPanelOpen}
			{chain}
			{collection}
			token={null}
			job={null}
			draft={selectedBiddingDraft}
			{bidBook}
			biddingSettings={activeBiddingSettings}
			priceTiers={activePriceTiers}
			expandSignal={biddingPanelExpandSignal}
			onClose={closeBiddingAutomationPanel}
			onJobsChange={handleJobsChanged}
		/>
	{/if}
</CollectionPageLayout>
