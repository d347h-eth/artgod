<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { onMount, tick } from 'svelte';
	import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
	import {
		DEFAULT_BIDDING_BID_BOOK_LIVE_REFRESH_CONFIG,
		type BiddingBidBookLiveRefreshConfig
	} from '@artgod/shared/config/bidding';
	import type {
		ApiBiddingBidBook,
		ApiBiddingBidBookRow,
		ApiBiddingCollectionSettings,
		ApiBiddingJob,
		ApiBiddingPriceTier,
		ApiBiddingTokenOfferCard,
		ApiBiddingTokenOfferCardsPage,
		ApiChain,
		ApiCollection,
		ApiCollectionBiddingBidScopeFilter,
		ApiCollectionBiddingTraitFilterJoinMode,
		ApiCollectionMediaState,
		ApiTokenAttribute,
		ApiTraitFacet,
		ApiTraitRangeFilter,
		CollectionBiddingBidBookApiResponse
	} from '$lib/api-types';
	import {
		BID_SCOPE_QUERY_PARAM,
		COLLECTION_BIDDING_BID_SCOPE_FILTER,
		COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
		buildCollectionBiddingHref,
		buildCollectionBiddingQuery,
		nextCollectionBiddingBidScopeFilter
	} from '$lib/bidding-query';
	import {
		BID_BOOK_RELATIVE_TIME_TICK_MS,
		bidBookNextUpdateTitle,
		bidBookRefreshPaceLabel,
		bidBookRefreshPaceTitle,
		formatBidBookNextUpdate
	} from '$lib/bidding-bid-book-source';
	import {
		biddingBidBookLivePollIntervalMs,
		captureBiddingLiveRefreshAnchor,
		restoreBiddingLiveRefreshAnchor,
		startBiddingBidBookLiveRefresh
	} from '$lib/bidding-live-refresh';
	import {
		BIDDING_SELECTION_JOB_ACTION,
		resolveBiddingTokenActionLabel,
		type BiddingSelectionJobAction
	} from '$lib/bidding-selection-actions';
	import { bidBookPriceEffectiveWei } from '$lib/bidding-bid-book-price';
	import { ownBidStatusBadges, type BidBookOwnStatusBadge } from '$lib/bidding-bid-book-own-status';
	import {
		BID_BOOK_UPDATE_FLASH_MODE,
		bidBookUpdateFlash
	} from '$lib/bid-book-update-flash';
	import { writeCollectionBiddingNavigationPreference } from '$lib/bidding-navigation-preferences';
	import { emptyBiddingTokenOfferCardsPage } from '$lib/bidding-empty-state';
	import { getCollectionBiddingBidBook } from '$lib/backend-api';
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
	import { resolveCollectionBiddingSelectionControlPolicy } from '$lib/bidding-selection-control-policy';
	import { resolveBidBookTraitDemandGroupPreview } from '$lib/bid-book-trait-previews';
	import {
		BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE,
		buildBiddingAutomationTokenFilterSnapshot,
		buildBiddingAutomationDraftFromSelection,
		buildBiddingAutomationDraftFromBid,
		biddingTraitCriteriaToTokenAttributes,
		canDraftTraitJobFromFilters,
		withMarketplaceBiddingTraitSupport,
		type BiddingAutomationTokenFilterSnapshot
	} from '$lib/bidding-automation';
	import {
		buildCollectionNavigation,
		handleCollectionSectionShortcut
	} from '$lib/collection-navigation';
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
		refreshPaginationWindowFromHead,
		resolvePaginationWindow,
		traitFilterPaginationSignatureParts,
		writePaginationWindow,
		type PaginationWindowState
	} from '$lib/components/pagination-window';
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
	import {
		applyBiddingSelectionJobAction,
		canApplyBiddingSelectionJobAction
	} from '$lib/bidding-automation-panel-actions';

	let {
		chain,
		collection,
		biddingSettings,
		priceTiers = [],
		bidBookLiveRefreshConfig = DEFAULT_BIDDING_BID_BOOK_LIVE_REFRESH_CONFIG,
		bidBook,
		tokenOfferCards = emptyBiddingTokenOfferCardsPage(),
		facets,
		media,
		basePath,
		selectedTraits,
		selectedTraitRanges,
		bidScope,
		traitJoinMode,
		showMuted = false,
		makerFilter = null,
		mediaMode,
		requestCursor = null
	}: {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		biddingSettings: ApiBiddingCollectionSettings;
		priceTiers?: ApiBiddingPriceTier[];
		bidBookLiveRefreshConfig?: BiddingBidBookLiveRefreshConfig;
		bidBook: ApiBiddingBidBook;
		tokenOfferCards?: ApiBiddingTokenOfferCardsPage;
		facets: ApiTraitFacet[];
		media: ApiCollectionMediaState;
		basePath: string;
		selectedTraits: ApiTokenAttribute[];
		selectedTraitRanges: ApiTraitRangeFilter[];
		bidScope: ApiCollectionBiddingBidScopeFilter;
		traitJoinMode: ApiCollectionBiddingTraitFilterJoinMode;
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
	let activeBiddingSettings = $state<ApiBiddingCollectionSettings>(biddingSettings);
	let activePriceTiers = $state<ApiBiddingPriceTier[]>(priceTiers);
	let activeBidBook = $state<ApiBiddingBidBook>(bidBook);
	let activeTokenOfferCardsPage =
		$state<ApiBiddingTokenOfferCardsPage>(tokenOfferCards);
	let activeTraits = $state<ApiTokenAttribute[]>(selectedTraits);
	let activeTraitRanges = $state<ApiTraitRangeFilter[]>(selectedTraitRanges);
	let visibleTokenOfferCards = $state<ApiBiddingTokenOfferCard[]>(tokenOfferCards.items);
	let tokenOffersRangeStart = $state(tokenOfferCards.rangeStart);
	let tokenOffersRangeEnd = $state(tokenOfferCards.rangeEnd);
	let tokenOffersPagesLoaded = $state(tokenOfferCards.items.length === 0 ? 0 : 1);
	let tokenOffersHeadRequestCursor = $state<string | null>(requestCursor);
	let tokenOffersHeadPrevCursor = $state<string | null>(tokenOfferCards.prevCursor);
	let tokenOffersTailNextCursor = $state<string | null>(tokenOfferCards.nextCursor);
	let tokenOffersPagingPending = $state(false);
	let lastBiddingFilterKey = $state('');
	let biddingPanelExpandSignal = $state(0);
	let priceTierPanelOpen = $state(false);
	let biddingContentElement = $state<HTMLDivElement | null>(null);
	let liveRefreshRequestId = 0;
	let bidBookMetadataNowMs = $state(Date.now());
	let bidBookNextUpdateAtMs = $state<number | null>(null);
	let refreshedTokenOfferWindow: PaginationWindowState<ApiBiddingTokenOfferCard> | null = null;
	let selectionJobActionBusy = $state<BiddingSelectionJobAction | null>(null);
	let armedSelectionJobAction = $state<BiddingSelectionJobAction | null>(null);
	let selectionJobActionMessage = $state<string | null>(null);
	let selectionJobActionError = $state<string | null>(null);
	let lastSelectionJobActionKey = $state('');

	const hasActiveTraitFilters = $derived(activeTraits.length > 0 || activeTraitRanges.length > 0);
	const showBidBookFilters = $derived(
		bidScope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token ||
			bidScope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits
	);
	const showBidBookTraitJoinControls = $derived(
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
			totalItems: activeTokenOfferCardsPage.totalItems,
			rangeStart: tokenOffersRangeStart,
			rangeEnd: tokenOffersRangeEnd,
			limit: activeTokenOfferCardsPage.limit,
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
	const showSelectionJobActions = $derived(
		!!selectedBiddingDraft && canApplyBiddingSelectionJobAction(selectedBiddingDraft)
	);
	const selectionJobActionDisabled = $derived(
		!chain || !collection || !showSelectionJobActions || selectionJobActionBusy !== null
	);
	const ownMakerAddress = $derived(activeBidBook.ownMakerAddress);
	const biddingFilterKey = $derived(activeBiddingFilterKey());
	const activeTraitsWithBiddingSupport = $derived(
		withMarketplaceBiddingTraitSupport({
			selectedTraits: activeTraits,
			facets
		})
	);
	const canBidOnTraits = $derived(
		canDraftTraitJobFromFilters({
			selectedTraits: activeTraits,
			selectedTraitRanges: activeTraitRanges
		})
	);
	const canRefineTokenSelectionToVisiblePage = $derived(
		activeTokenOfferCardsPage.totalPages > 1
	);
	const tokenActionLabel = $derived(
		resolveBiddingTokenActionLabel({
			allFilteredSelectionActive: isAllFilteredTokenSelectionActive(),
			canRefineTokenSelectionToVisiblePage
		})
	);
	const biddingSelectionControlPolicy = $derived(
		resolveCollectionBiddingSelectionControlPolicy({
			publicSingleCollection: IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
			bidScope,
			canBidOnTraits,
			hasSelectionSummary: biddingSelectionSummary !== null
		})
	);
	const TraitDemandGroupPreview = $derived(
		resolveBidBookTraitDemandGroupPreview(collection?.extensions ?? [])
	);

	onMount(() => {
		const refresh = startBiddingBidBookLiveRefresh({
			refresh: () => refreshCollectionBiddingData(),
			intervalMs: () =>
				biddingBidBookLivePollIntervalMs(activeBidBook.state.source, bidBookLiveRefreshConfig),
			onNextUpdate: (nextUpdateAtMs) => {
				bidBookNextUpdateAtMs = nextUpdateAtMs;
				bidBookMetadataNowMs = Date.now();
			}
		});
		const metadataTimer = window.setInterval(() => {
			bidBookMetadataNowMs = Date.now();
		}, BID_BOOK_RELATIVE_TIME_TICK_MS);
		return () => {
			refresh.stop();
			window.clearInterval(metadataTimer);
		};
	});

	$effect(() => {
		activeBiddingSettings = biddingSettings;
	});

	$effect(() => {
		activePriceTiers = priceTiers;
	});

	$effect(() => {
		activeBidBook = bidBook;
	});

	$effect(() => {
		activeTokenOfferCardsPage = tokenOfferCards;
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
			refreshedTokenOfferWindow = null;
			return;
		}

		const signature = tokenOfferWindowSignature();
		const incoming = pageToPaginationWindow(activeTokenOfferCardsPage, requestCursor);
		const cached = browser ? readPaginationWindow<ApiBiddingTokenOfferCard>(signature) : null;
		const resolved =
			refreshedTokenOfferWindow ??
			resolvePaginationWindow({
				cached,
				incoming,
				requestCursor,
				itemKey: (token) => token.tokenId
			});

		visibleTokenOfferCards = resolved.items;
		tokenOffersRangeStart = resolved.rangeStart;
		tokenOffersRangeEnd = resolved.rangeEnd;
		tokenOffersPagesLoaded = resolved.pagesLoaded;
		tokenOffersHeadRequestCursor = resolved.headRequestCursor;
		tokenOffersHeadPrevCursor = resolved.headPrevCursor;
		tokenOffersTailNextCursor = resolved.tailNextCursor;

		if (browser) {
			writePaginationWindow(signature, resolved);
		}

		tokenOffersPagingPending = false;
		refreshedTokenOfferWindow = null;
	});

	$effect(() => {
		if (bidScope !== COLLECTION_BIDDING_BID_SCOPE_FILTER.Token) {
			return;
		}
		biddingAutomation.pruneInvisibleTokenSelection(visibleTokenOfferCardIds);
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

	$effect(() => {
		const nextKey = biddingSelectionStateKey;
		if (nextKey === lastSelectionJobActionKey) {
			return;
		}
		lastSelectionJobActionKey = nextKey;
		armedSelectionJobAction = null;
		selectionJobActionMessage = null;
		selectionJobActionError = null;
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
			collectionExtensions: collection?.extensions ?? [],
			bidding: {
				...collectionBiddingNavigationVisibilityForDeployment(),
				bidScope,
				traitJoinMode,
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
			mediaMode,
			maker: makerFilter,
			showMuted
		});
	}

	function bidScopeHref(nextBidScope: ApiCollectionBiddingBidScopeFilter): string {
		const query = buildCollectionBiddingQuery({
			selectedTraits: activeTraits,
			selectedTraitRanges: activeTraitRanges,
			bidScope: nextBidScope,
			traitJoinMode,
			mediaMode,
			maker: makerFilter,
			showMuted
		});
		// Keep clicked scopes explicit so stored preferences cannot override a scope change.
		query.set(BID_SCOPE_QUERY_PARAM, nextBidScope);
		return withQuery(biddingPath(), query);
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
			mediaMode,
			maker: makerFilter,
			limit: activeTokenOfferCardsPage.limit,
			cursor
		});
		// Keep token scope explicit on pagination so stored preferences cannot redirect away.
		query.set(BID_SCOPE_QUERY_PARAM, COLLECTION_BIDDING_BID_SCOPE_FILTER.Token);
		return withQuery(biddingPath(), query);
	}

	function currentBidBookQuery(cursor: string | null = requestCursor): URLSearchParams {
		return buildCollectionBiddingQuery({
			selectedTraits: activeTraits,
			selectedTraitRanges: activeTraitRanges,
			bidScope,
			traitJoinMode,
			mediaMode,
			maker: makerFilter,
			showMuted,
			limit: activeTokenOfferCardsPage.limit,
			cursor
		});
	}

	async function refreshCollectionBiddingData(): Promise<void> {
		if (!chain || !collection) return;
		const requestId = liveRefreshRequestId + 1;
		liveRefreshRequestId = requestId;
		const refreshKey = activeBiddingFilterKey();
		const anchor = captureBiddingLiveRefreshAnchor(biddingContentElement);

		try {
			// Fetch the current source-selected bid book directly so live refresh avoids route reloads.
			const response =
				bidScope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token
					? await refreshTokenOfferWindow({
							chainSlug: chain.slug,
							collectionSlug: collection.slug
						})
					: await getCollectionBiddingBidBook(
							fetch,
							chain.slug,
							collection.slug,
							currentBidBookQuery()
						);
			if (liveRefreshRequestId !== requestId || refreshKey !== activeBiddingFilterKey()) {
				return;
			}
			activeBidBook = response.bidBook;
			activeTokenOfferCardsPage = response.tokenOfferCards;
			await tick();
			if (liveRefreshRequestId === requestId) {
				restoreBiddingLiveRefreshAnchor(biddingContentElement, anchor);
			}
		} catch {
			// Keep the existing bid-book visible after transient live-refresh failures.
		}
	}

	async function refreshTokenOfferWindow(params: {
		chainSlug: string;
		collectionSlug: string;
	}): Promise<CollectionBiddingBidBookApiResponse> {
		const refreshed = await refreshPaginationWindowFromHead<
			ApiBiddingTokenOfferCard,
			CollectionBiddingBidBookApiResponse
		>({
			pagesLoaded: tokenOffersPagesLoaded,
			headRequestCursor: tokenOffersHeadRequestCursor,
			loadPage: (cursor) =>
				getCollectionBiddingBidBook(
					fetch,
					params.chainSlug,
					params.collectionSlug,
					currentBidBookQuery(cursor)
				),
			pageFromResponse: (response) => response.tokenOfferCards,
			itemKey: (token) => token.tokenId
		});

		refreshedTokenOfferWindow = refreshed.window;
		return {
			...refreshed.headResponse,
			bidBook: bidBookForTokenOfferWindow(refreshed.headResponse.bidBook, refreshed.window)
		};
	}

	function bidBookForTokenOfferWindow(
		bidBook: ApiBiddingBidBook,
		window: PaginationWindowState<ApiBiddingTokenOfferCard>
	): ApiBiddingBidBook {
		return {
			...bidBook,
			bids: window.items.flatMap((token) => token.offers)
		};
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
			activeTokenOfferCardsPage.limit,
			activeBidBook.state.source,
			media.selectedMode,
			makerFilter ?? 'all-makers',
			showMuted ? 'show-muted' : 'hide-muted',
			...traitFilterPaginationSignatureParts({ traits: activeTraits, ranges: activeTraitRanges })
		]);
	}

	function handlePriceTiersChanged(nextTiers: ApiBiddingPriceTier[]): void {
		activePriceTiers = nextTiers;
	}

	function handleBiddingSettingsChanged(nextSettings: ApiBiddingCollectionSettings): void {
		activeBiddingSettings = nextSettings;
	}

	function handleBiddingJobsChanged(_jobs: ApiBiddingJob[]): void {
		void refreshCollectionBiddingData();
	}

	function togglePriceTierPanel(): void {
		priceTierPanelOpen = !priceTierPanelOpen;
	}

	function traitJoinModeHref(nextMode: ApiCollectionBiddingTraitFilterJoinMode): string {
		return buildCollectionBiddingHref({
			basePath,
			selectedTraits: activeTraits,
			selectedTraitRanges: activeTraitRanges,
			bidScope,
			traitJoinMode: nextMode,
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
		await goto(bidScopeHref(nextCollectionBiddingBidScopeFilter(bidScope)), {
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
		const count = activeTokenOfferCardsPage.totalItems;
		return count === 1 ? '1 token' : `${count} tokens`;
	}

	function bidOnFilteredTraits(): void {
		if (!canBidOnTraits) return;
		biddingAutomation.selectFilteredTokens(
			buildFilteredTraitBiddingSelectionInput({
				tokenCount: activeTokenOfferCardsPage.totalItems,
				filter: currentBiddingFilterSnapshot({
					traits: activeTraitsWithBiddingSupport
				})
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
				tokenCount: activeTokenOfferCardsPage.totalItems,
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
		const existingJob = null;
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
		const topBid = activeBidBook.bids[0];
		if (!topBid) return;
		onBidBookSelectBid(topBid);
	}

	function closeBiddingAutomationPanel(): void {
		biddingAutomation.clearSelection();
	}

	function clearBiddingSelection(): void {
		biddingAutomation.clearSelection();
		armedSelectionJobAction = null;
		selectionJobActionMessage = null;
		selectionJobActionError = null;
	}

	function expandBiddingAutomationPanel(): void {
		biddingPanelExpandSignal += 1;
	}

	async function onSelectionJobAction(action: BiddingSelectionJobAction): Promise<void> {
		if (armedSelectionJobAction !== action) {
			armedSelectionJobAction = action;
			return;
		}
		armedSelectionJobAction = null;
		if (!chain || !collection || !selectedBiddingDraft || selectionJobActionBusy) {
			return;
		}

		selectionJobActionBusy = action;
		selectionJobActionMessage = null;
		selectionJobActionError = null;
		try {
			// Fan out through existing job mutation routes so status changes preserve each job's pricing.
			const result = await applyBiddingSelectionJobAction({
				fetchFn: fetch,
				chainRef: chain.slug,
				collectionRef: collection.slug,
				draft: selectedBiddingDraft,
				action
			});
			selectionJobActionMessage = selectionJobActionResultMessage(action, result.jobs.length);
			await refreshCollectionBiddingData();
		} catch (error) {
			selectionJobActionError =
				error instanceof Error ? error.message : 'failed to update selected bidding jobs';
		} finally {
			selectionJobActionBusy = null;
		}
	}

	function selectionJobActionResultMessage(
		action: BiddingSelectionJobAction,
		changedCount: number
	): string {
		if (changedCount === 0) {
			return 'no changes';
		}
		const subject = changedCount === 1 ? '1 job' : `${changedCount} jobs`;
		if (action === BIDDING_SELECTION_JOB_ACTION.Activate) {
			return `activated ${subject}`;
		}
		if (action === BIDDING_SELECTION_JOB_ACTION.Pause) {
			return `paused ${subject}`;
		}
		return `archived ${subject}`;
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
		bidBook={activeBidBook}
		nextUpdateAtMs={bidBookNextUpdateAtMs}
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
		{TraitDemandGroupPreview}
	/>
{/snippet}

<CollectionPageLayout
	navigation={collectionNavigation()}
	activeSection="bidding"
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
			{#if !IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT && biddingSelectionControlPolicy.renderRow && !biddingSelectionControlPolicy.showCollectionAction}
				<div class="panel-top-actions-row">
					<BiddingSelectionControls
						summary={biddingSelectionSummary}
						showTraitAction={biddingSelectionControlPolicy.showTraitAction}
						showTokenAction={biddingSelectionControlPolicy.showTokenAction}
						showTierAction={biddingSelectionControlPolicy.showTierAction}
						showJobActions={showSelectionJobActions}
						tierActionActive={priceTierPanelOpen}
						tokenActionLabel={tokenActionLabel}
						tokenActionDisabled={activeTokenOfferCardsPage.totalItems === 0}
						jobActionDisabled={selectionJobActionDisabled}
						jobActionBusy={selectionJobActionBusy}
						armedJobAction={armedSelectionJobAction}
						jobActionMessage={selectionJobActionMessage}
						jobActionError={selectionJobActionError}
						onToggleTiers={togglePriceTierPanel}
						onBidOnTraits={bidOnFilteredTraits}
						onBidOnTokens={bidOnFilteredTokenOffers}
						onJobAction={onSelectionJobAction}
						onClear={clearBiddingSelection}
					/>
				</div>
			{:else if !IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT && biddingSelectionControlPolicy.renderRow && biddingSelectionControlPolicy.showCollectionAction}
				<div class="panel-top-actions-row">
					<BiddingSelectionControls
						summary={biddingSelectionSummary}
						showTraitAction={biddingSelectionControlPolicy.showTraitAction}
						showTokenAction={biddingSelectionControlPolicy.showTokenAction}
						showCollectionAction={biddingSelectionControlPolicy.showCollectionAction}
						showTierAction={biddingSelectionControlPolicy.showTierAction}
						showJobActions={showSelectionJobActions}
						tierActionActive={priceTierPanelOpen}
						collectionActionDisabled={activeBidBook.bids.length === 0}
						jobActionDisabled={selectionJobActionDisabled}
						jobActionBusy={selectionJobActionBusy}
						armedJobAction={armedSelectionJobAction}
						jobActionMessage={selectionJobActionMessage}
						jobActionError={selectionJobActionError}
						onToggleTiers={togglePriceTierPanel}
						onBidOnTokens={bidOnFilteredTokenOffers}
						onBidOnCollection={placeCollectionBid}
						onJobAction={onSelectionJobAction}
						onClear={clearBiddingSelection}
					/>
				</div>
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
			onJobsChange={handleBiddingJobsChanged}
			onClose={togglePriceTierPanel}
		/>
	{/if}

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

			<div class="token-panel bidding-panel-main" bind:this={biddingContentElement}>
				{#if bidScope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token}
					<section class="runtime-section bid-book-summary-panel">
							<div class="runtime-kv-grid bid-book-meta">
								<div>
									<span class="runtime-k">refresh pace</span>
									<span class="runtime-v" title={bidBookRefreshPaceTitle(activeBidBook.state.source)}>
										{bidBookRefreshPaceLabel(activeBidBook.state.source)}
									</span>
								</div>
								<div>
									<span class="runtime-k">tokens</span>
									<span class="runtime-v">{activeTokenOfferCardsPage.totalItems}</span>
								</div>
								<div>
									<span class="runtime-k">offers</span>
									<span class="runtime-v">{activeTokenOfferCardsPage.totalOffers}</span>
								</div>
								<div>
									<span class="runtime-k">next refresh</span>
									<span
										class="runtime-v mono bid-book-update-chip"
										title={bidBookNextUpdateTitle(bidBookNextUpdateAtMs)}
										use:bidBookUpdateFlash={{
											key: bidBookNextUpdateAtMs,
											mode: BID_BOOK_UPDATE_FLASH_MODE.Transient
										}}
									>
										{formatBidBookNextUpdate(bidBookNextUpdateAtMs, bidBookMetadataNowMs)}
									</span>
								</div>
							</div>
							{#if activeBidBook.state.lastError}
								<p class="runtime-error bid-book-error" role="alert">{activeBidBook.state.lastError}</p>
							{/if}
					</section>

					<section class="token-offers-panel">
							<CursorPaginationControls
								resultsSummary={tokenOffersResultsSummary()}
								totalItems={activeTokenOfferCardsPage.totalItems}
								rangeStart={tokenOffersRangeStart}
								rangeEnd={tokenOffersRangeEnd}
								totalPages={activeTokenOfferCardsPage.totalPages}
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
		<div class="token-panel bidding-panel-main" bind:this={biddingContentElement}>
			{@render bidBookPanel()}
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
			bidBook={activeBidBook}
			biddingSettings={activeBiddingSettings}
			priceTiers={activePriceTiers}
			expandSignal={biddingPanelExpandSignal}
			onClose={closeBiddingAutomationPanel}
			onJobsChange={handleBiddingJobsChanged}
		/>
	{/if}
</CollectionPageLayout>
