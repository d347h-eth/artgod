<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { onMount, tick } from 'svelte';
	import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
	import {
		DEFAULT_BIDDING_BID_BOOK_LIVE_REFRESH_CONFIG,
		type BiddingBidBookLiveRefreshConfig
	} from '@artgod/shared/config/bidding';
	import { COLLECTION_MEDIA_MODE_OPTIONS, COLLECTION_MEDIA_MODES } from '@artgod/shared/extensions';
	import {
		TRADING_BIDDING_BID_SCOPE_KIND,
		resolveTraitFilterDisplayKind,
		TRAIT_FILTER_DISPLAY_KIND
	} from '@artgod/shared/types';
	import BidBookPanel from '$lib/components/BidBookPanel.svelte';
	import BiddingAutomationPanel from '$lib/components/BiddingAutomationPanel.svelte';
	import LoadingBladeBar from '$lib/components/LoadingBladeBar.svelte';
	import TokenMediaFrame from '$lib/components/TokenMediaFrame.svelte';
	import TokenDetailMediaError from '$lib/components/TokenDetailMediaError.svelte';
	import { isKeyboardTextEntryTarget } from '$lib/components/keyboard-targets';
	import TokenDetailExtensionSectionOutlet from '$lib/token-detail-extension-sections/TokenDetailExtensionSectionOutlet.svelte';
	import type {
		ApiBiddingBidBook,
		ApiBiddingBidBookRow,
		ApiBiddingCollectionSettings,
		ApiBiddingJob,
		ApiBiddingPriceTier,
		ApiChain,
		ApiCollection,
		ApiCollectionBiddingBidScopeFilter,
		ApiTraitFilterPresentationFeatureState,
		ApiTokenDetail,
		ApiTokenMediaState,
		ApiTokenDetailTrait
	} from '$lib/api-types';
	import { buildCollectionActivityHref } from '$lib/activity-query';
	import { defaultBiddingCollectionSettings } from '$lib/bidding-collection-settings';
	import { emptyBiddingBidBook } from '$lib/bidding-empty-state';
	import { getTokenBiddingBidBook, getTokenBiddingJob, getTokenDetail } from '$lib/backend-api';
	import {
		biddingBidBookLivePollIntervalMs,
		captureBiddingLiveRefreshAnchor,
		restoreBiddingLiveRefreshAnchor,
		startBiddingBidBookLiveRefresh
	} from '$lib/bidding-live-refresh';
	import {
		BID_SCOPE_QUERY_PARAM,
		COLLECTION_BIDDING_BID_SCOPE_FILTER,
		COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
		buildCollectionBiddingQuery
	} from '$lib/bidding-query';
	import {
		bestBiddingAutomationBid,
		buildBiddingAutomationDraftFromBid,
		buildTokenBiddingAutomationDraftFromBid,
		buildTraitBiddingAutomationDraftFromTrait,
		biddingTraitCriteriaToTokenAttributes,
		type BiddingAutomationDraft
	} from '$lib/bidding-automation';
	import { BIDDING_SELECTION_ACTION_LABEL } from '$lib/bidding-selection-actions';
	import { formatListingPrice } from '$lib/listing-price';
	import { openseaItemHref as buildOpenseaItemHref } from '$lib/marketplace-links';
	import {
		appendCollectionMediaParams,
		buildTokenMediaQuery,
		nextMediaOption
	} from '$lib/media-mode';
	import {
		IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
		publicCollectionOwnerTokensPath,
		publicCollectionTokensPath
	} from '$lib/runtime/public-deployment';
	import { resolveTraitFilterPresentationState } from '$lib/trait-filter-presentation';
	import {
		resolveTokenMediaAspectRatio,
		resolveTokenMediaIframeSource,
		tokenMediaTitle,
		type TokenMediaIframeSource
	} from '$lib/token-media';
	import {
		buildOwnerTokensHref,
		buildTokenBrowserHref,
		parseCollectionTokenStatus,
		parseDisplayMode
	} from '$lib/token-browser-query';
	import { joinPath, withQuery } from '$lib/route-paths';
	import PlaceBidIcon from '$lib/components/PlaceBidIcon.svelte';
	import {
		resolveTokenDetailExtensionSections,
		type TokenDetailExtensionSection
	} from '$lib/token-detail-extension-sections';
	import type { TokenDetailExtensionSectionHrefs } from '$lib/token-detail-extension-sections/types';

	type PageData = {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		media: ApiTokenMediaState;
		token: ApiTokenDetail | null;
		biddingSettings?: ApiBiddingCollectionSettings;
		priceTiers?: ApiBiddingPriceTier[];
		trustOpenSeaSignedZoneTraitOffers?: boolean;
		traitFilterPresentation?: ApiTraitFilterPresentationFeatureState;
		tokenBiddingJob?: ApiBiddingJob | null;
		tokenBiddingBidBook?: ApiBiddingBidBook;
		bidBookLiveRefreshConfig?: BiddingBidBookLiveRefreshConfig;
		showMuted?: boolean;
		backPath: string | null;
		backQuery: string | null;
	};

	type TokenDetailMediaRequest = {
		mediaMode: string;
		mediaVariant: string | null;
	};

	let { data }: { data?: PageData } = $props();
	let displayedToken = $state<ApiTokenDetail | null>(data?.token ?? null);
	let displayedMedia = $state<ApiTokenMediaState>(resolveInitialMediaState(data?.media));
	let displayedMediaAspectRatio = $state<number | null>(null);
	let tokenDetailMediaError = $state<string | null>(null);
	let failedTokenDetailMediaRequest = $state<TokenDetailMediaRequest | null>(null);
	let tokenDetailMediaPending = $state(false);
	let tokenBiddingJob = $state<ApiBiddingJob | null>(data?.tokenBiddingJob ?? null);
	let tokenBiddingBidBook = $state<ApiBiddingBidBook>(
		data?.tokenBiddingBidBook ?? emptyBiddingBidBook()
	);
	let selectedTokenBidBookBid = $state<ApiBiddingBidBookRow | null>(null);
	let selectedTokenTraitTarget = $state<ApiTokenDetailTrait | null>(null);
	let tokenBiddingPanelOpen = $state(false);
	let tokenBiddingPanelExpandSignal = $state(0);
	let tokenBiddingContentElement = $state<HTMLElement | null>(null);
	let tokenBiddingNextUpdateAtMs = $state<number | null>(null);
	let tokenDetailRequestId = 0;
	let tokenBiddingRefreshRequestId = 0;
	const tokenBiddingDraft = $derived(resolveTokenBiddingDraft());

	onMount(() => {
		const refresh = startBiddingBidBookLiveRefresh({
			refresh: () => refreshTokenBiddingData(),
			intervalMs: () =>
				biddingBidBookLivePollIntervalMs(
					tokenBiddingBidBook.state.source,
					data?.bidBookLiveRefreshConfig ?? DEFAULT_BIDDING_BID_BOOK_LIVE_REFRESH_CONFIG
				),
			onNextUpdate: (nextUpdateAtMs) => {
				tokenBiddingNextUpdateAtMs = nextUpdateAtMs;
			}
		});
		return () => {
			refresh.stop();
		};
	});

	$effect(() => {
		displayedToken = data?.token ?? null;
		displayedMedia = resolveInitialMediaState(data?.media);
		displayedMediaAspectRatio = null;
		tokenDetailMediaError = null;
		failedTokenDetailMediaRequest = null;
		tokenDetailMediaPending = false;
		tokenBiddingJob = data?.tokenBiddingJob ?? null;
		tokenBiddingBidBook = data?.tokenBiddingBidBook ?? emptyBiddingBidBook();
		selectedTokenBidBookBid = null;
		selectedTokenTraitTarget = null;
		tokenBiddingPanelOpen = false;
		tokenDetailRequestId += 1;
	});

	function collectionHref(): string {
		if (!data?.chain || !data.collection) return '/';
		const base =
			data.backPath ??
			(IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT
				? publicCollectionTokensPath()
				: `/${data.chain.slug}/${data.collection.slug}`);
		if (data.backQuery) return `${base}?${data.backQuery}`;
		const query = new URLSearchParams();
		appendCollectionMediaParams(query, collectionNavigationMediaState());
		const suffix = query.toString();
		return suffix ? `${base}?${suffix}` : base;
	}

	function holderHref(): string | null {
		if (!data?.chain || !data.collection || !displayedToken?.currentHolder) return null;
		if (IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) {
			const query = new URLSearchParams();
			appendCollectionMediaParams(query, collectionNavigationMediaState());
			const suffix = query.toString();
			const path = publicCollectionOwnerTokensPath(displayedToken.currentHolder);
			return suffix ? `${path}?${suffix}` : path;
		}
		return buildOwnerTokensHref({
			basePath: `/${data.chain.slug}/${data.collection.slug}/holders/${encodeURIComponent(displayedToken.currentHolder)}`,
			selectedTraits: [],
			selectedTraitRanges: [],
			mediaMode: collectionNavigationMediaMode(),
			mediaPreference: displayedMedia.preference
		});
	}

	function openseaItemHref(): string | null {
		return buildOpenseaItemHref({
			chainSlug: data?.chain?.slug ?? null,
			collectionAddress: data?.collection?.address ?? null,
			tokenId: displayedToken?.tokenId ?? null
		});
	}

	function tokenListingLabel(): string | null {
		return formatListingPrice(displayedToken?.listingPrice ?? null, displayedToken?.listingCurrency ?? null);
	}

	function openseaLinkLabel(): string {
		const listingLabel = tokenListingLabel();
		return listingLabel ? `${listingLabel} [OS]` : '[OS]';
	}

	function backLabel(): string {
		if (!data?.chain || !data.collection) return 'back';
		const collectionPath = `/${data.chain.slug}/${data.collection.slug}`;
		if (IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) {
			return data.backPath && data.backPath.endsWith('/bidding')
				? 'back to bidding'
				: data.backPath && data.backPath !== publicCollectionTokensPath()
					? 'back to holder'
					: 'back to collection';
		}
		if (data.backPath && data.backPath.endsWith('/bidding')) {
			return 'back to bidding';
		}
		return data.backPath && data.backPath !== collectionPath ? 'back to holder' : 'back to collection';
	}

	function bidBookMakerHref(bid: ApiBiddingBidBookRow): string | null {
		const makerAddress = bid.maker.address;
		if (!makerAddress) {
			return null;
		}
		const bidScope = bidBookScopeForBid(bid);
		const query = buildCollectionBiddingQuery({
			selectedTraits: [],
			selectedTraitRanges: [],
			bidScope,
			mediaMode: collectionNavigationMediaMode(),
			mediaPreference: displayedMedia.preference,
			maker: makerAddress,
			showMuted: data?.showMuted ?? false
		});
		// Keep the clicked bid scope explicit so stored scope preferences cannot override this jump.
		query.set(BID_SCOPE_QUERY_PARAM, bidScope);
		return withQuery(joinPath(collectionTokensBasePath(), 'bidding'), query);
	}

	function bidBookScopeForBid(bid: ApiBiddingBidBookRow): ApiCollectionBiddingBidScopeFilter {
		if (bid.scope.kind === TRADING_BIDDING_BID_SCOPE_KIND.Collection) {
			return COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection;
		}
		if (bid.scope.kind === TRADING_BIDDING_BID_SCOPE_KIND.Trait) {
			return COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits;
		}
		return COLLECTION_BIDDING_BID_SCOPE_FILTER.Token;
	}

	function shouldShowTokenBidBook(): boolean {
		return !!data?.chain && !!data.collection && !!displayedToken;
	}

	function shouldShowTokenBiddingAutomation(): boolean {
		return !IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT && !!data?.chain && !!data.collection && !!displayedToken;
	}

	function onTokenBiddingJobChange(nextJob: ApiBiddingJob | null): void {
		tokenBiddingJob = nextJob;
	}

	function onTokenBiddingJobsChange(): void {
		void refreshTokenBiddingData();
	}

	function resolveTokenBiddingDraft(): BiddingAutomationDraft | null {
		if (!displayedToken) {
			return null;
		}
		if (selectedTokenBidBookBid) {
			return buildBiddingAutomationDraftFromBid(
				selectedTokenBidBookBid,
				existingJobForSelectedBid(selectedTokenBidBookBid)
			);
		}
		if (selectedTokenTraitTarget) {
			return buildTraitBiddingAutomationDraftFromTrait({
				trait: {
					key: selectedTokenTraitTarget.key,
					value: selectedTokenTraitTarget.value,
					marketplaceBiddingSupported:
						selectedTokenTraitTarget.marketplaceBiddingSupported
				},
				tokenCount: selectedTokenTraitTarget.tokenCount
			});
		}
		if (tokenBiddingJob) {
			return null;
		}
		const topBid = bestBiddingAutomationBid(tokenBiddingBidBook.bids);
		if (!topBid) {
			return null;
		}
		return buildTokenBiddingAutomationDraftFromBid(topBid, displayedToken.tokenId);
	}

	function existingJobForSelectedBid(bid: ApiBiddingBidBookRow): ApiBiddingJob | null {
		// Only reuse the page token job when the selected bid targets the displayed token.
		if (
			bid.scope.kind === TRADING_BIDDING_BID_SCOPE_KIND.Token &&
			bid.scope.tokenId === displayedToken?.tokenId
		) {
			return tokenBiddingJob;
		}
		return null;
	}

	function canSelectTokenDetailBidBookBid(bid: ApiBiddingBidBookRow): boolean {
		return bid.scope.kind !== TRADING_BIDDING_BID_SCOPE_KIND.Collection;
	}

	function onBidBookSelectBid(bid: ApiBiddingBidBookRow): void {
		selectedTokenBidBookBid = bid;
		selectedTokenTraitTarget = null;
		openTokenBiddingPanel();
	}

	function bidOnDisplayedToken(): void {
		selectedTokenBidBookBid = null;
		selectedTokenTraitTarget = null;
		openTokenBiddingPanel();
	}

	function bidOnTokenTrait(trait: ApiTokenDetailTrait): void {
		selectedTokenBidBookBid = null;
		selectedTokenTraitTarget = trait;
		openTokenBiddingPanel();
	}

	function openTokenBiddingPanel(): void {
		tokenBiddingPanelOpen = true;
		tokenBiddingPanelExpandSignal += 1;
	}

	function closeTokenBiddingPanel(): void {
		tokenBiddingPanelOpen = false;
	}

	function tokenTraitBidLabel(trait: ApiTokenDetailTrait): string {
		return `place bid on ${trait.key}=${trait.value}`;
	}

	async function onBidBookTraitFilter(selection: {
		traits: ApiBiddingBidBookRow['scope']['traits'];
	}): Promise<void> {
		await goto(bidBookTraitsHref(biddingTraitCriteriaToTokenAttributes(selection.traits)));
	}

	function tokenDetailExtensionSections(): TokenDetailExtensionSection[] {
		if (!data?.chain || !data.collection || !displayedToken) return [];
		return resolveTokenDetailExtensionSections({
			chain: data.chain,
			collection: data.collection,
			token: displayedToken,
			media: displayedMedia
		});
	}

	function tokenDetailExtensionHrefs(): TokenDetailExtensionSectionHrefs {
		return {
			activityExtensionEvent: (event, filters = {}) =>
				buildCollectionActivityHref({
					basePath: collectionTokensBasePath(),
					limit: DEFAULT_PAGE_LIMIT,
					extensionEvent: event,
					selectedTraits: [],
					selectedTraitRanges: [],
					mediaMode: collectionNavigationMediaMode(),
					mediaPreference: displayedMedia.preference,
					tokenId: filters.tokenId ?? null,
					maker: filters.maker ?? null,
					contentHash: filters.contentHash ?? null,
					eventGroup: filters.eventGroup ?? null
				})
		};
	}

	function sortedTraits(): ApiTokenDetailTrait[] {
		const input = displayedToken?.attributes ?? [];
		return [...input].sort((a, b) => {
			const byKey = a.key.localeCompare(b.key);
			if (byKey !== 0) return byKey;
			return a.value.localeCompare(b.value);
		});
	}

	function resolveTokenTitle(token: ApiTokenDetail, collection: ApiCollection | null): string {
		const fallback = `${collection?.slug ?? ''} #${token.tokenId}`.trim();
		const normalizedFallback = fallback.toLowerCase();
		const candidate = token.name?.trim() ?? '';
		if (!candidate) return fallback;
		if (candidate.toLowerCase() === normalizedFallback) return fallback;
		return candidate;
	}

	$effect(() => {
		const imageUrl = displayedToken?.image?.trim() ?? '';
		displayedMediaAspectRatio = null;
		if (!browser || !imageUrl) return;

		let cancelled = false;
		const probe = new Image();
		probe.referrerPolicy = 'no-referrer';
		probe.onload = () => {
			if (cancelled) return;
			if (probe.naturalWidth > 0 && probe.naturalHeight > 0) {
				displayedMediaAspectRatio = probe.naturalWidth / probe.naturalHeight;
			}
		};
		probe.onerror = () => {
			if (cancelled) return;
			displayedMediaAspectRatio = null;
		};
		probe.src = imageUrl;

		return () => {
			cancelled = true;
			probe.onload = null;
			probe.onerror = null;
		};
	});

	function tokenMediaSource(token: ApiTokenDetail): TokenMediaIframeSource | null {
		return resolveTokenMediaIframeSource(
			token.animationUrl,
			token.image,
			tokenMediaTitle(token.tokenId)
		);
	}

	function tokenDetailMediaStyle(): string {
		return `--token-detail-ar:${resolveTokenMediaAspectRatio(displayedMediaAspectRatio, 1)};`;
	}

	function formatTraitCount(value: number | null): string {
		if (value === null) return '-';
		return String(value);
	}

	function formatRarityPercent(value: number | null): string {
		if (value === null) return '-';
		return `${value.toFixed(2)}%`;
	}

	function hasMediaSourceChoices(): boolean {
		return displayedMedia.availableModes.length > 1;
	}

	function shouldRenderMediaSourceRow(): boolean {
		return (
			displayedMedia.availableModes.length > 0 &&
			(hasMediaSourceChoices() || hasMediaVariants())
		);
	}

	function hasMediaVariantChoices(): boolean {
		return displayedMedia.availableVariants.length > 1;
	}

	function hasMediaVariants(): boolean {
		return displayedMedia.availableVariants.length > 0;
	}

	function currentTraitFilterPresentation(): ApiTraitFilterPresentationFeatureState {
		return resolveTraitFilterPresentationState(data?.traitFilterPresentation);
	}

	function collectionTokensBasePath(): string {
		if (IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) {
			return publicCollectionTokensPath();
		}
		if (!data?.chain || !data.collection) return '/';
		return `/${data.chain.slug}/${data.collection.slug}`;
	}

	function collectionNavigationMediaMode(): string | null {
		return displayedMedia.selectedMode;
	}

	function collectionNavigationMediaState(): {
		mediaMode: string | null;
		mediaPreference: ApiTokenMediaState['preference'];
	} {
		return {
			mediaMode: collectionNavigationMediaMode(),
			mediaPreference: displayedMedia.preference
		};
	}

	function returnedFromOwnerTokens(): boolean {
		const backPath = data?.backPath?.trim() ?? '';
		return backPath.includes('/holders/');
	}

	function parseReturnLimit(raw: string | null): number {
		if (!raw || !/^\d+$/.test(raw.trim())) {
			return DEFAULT_PAGE_LIMIT;
		}
		return Number(raw.trim());
	}

	function isFilterableSetTrait(key: string): boolean {
		return (
			resolveTraitFilterDisplayKind(currentTraitFilterPresentation().effectiveConfig, key) ===
			TRAIT_FILTER_DISPLAY_KIND.Set
		);
	}

	function traitValueHref(trait: ApiTokenDetailTrait): string | null {
		if (!data?.collection || !isFilterableSetTrait(trait.key)) {
			return null;
		}

		const returnQuery = new URLSearchParams(data.backQuery ?? '');
		const tokenStatus = returnedFromOwnerTokens()
			? 'listed'
			: parseCollectionTokenStatus(returnQuery.get('token_status'));

		return buildTokenBrowserHref({
			basePath: collectionTokensBasePath(),
			limit: parseReturnLimit(returnQuery.get('limit')),
			displayMode: parseDisplayMode(returnQuery.get('mode')),
			tokenStatus,
			selectedTraits: [{ key: trait.key, value: trait.value }],
			selectedTraitRanges: [],
			mediaMode: collectionNavigationMediaMode(),
			mediaPreference: displayedMedia.preference
		});
	}

	function bidBookTraitValueHref(trait: { key: string; value: string }): string {
		return bidBookTraitsHref([trait]);
	}

	function bidBookTraitsHref(traits: { key: string; value: string }[]): string {
		const query = buildCollectionBiddingQuery({
			selectedTraits: traits,
			selectedTraitRanges: [],
			bidScope: COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits,
			traitJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
			mediaMode: collectionNavigationMediaMode(),
			mediaPreference: displayedMedia.preference,
			showMuted: data?.showMuted ?? false
		});
		// Keep trait bid scope explicit so stored scope preferences cannot override this jump.
		query.set(BID_SCOPE_QUERY_PARAM, COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits);
		return withQuery(joinPath(collectionTokensBasePath(), 'bidding'), query);
	}

	async function setTokenDetailMediaMode(nextMode: string): Promise<void> {
		if (!browser || !data?.chain || !data.collection || !displayedToken) {
			return;
		}
		if (!hasMediaSourceChoices() || tokenDetailMediaPending) {
			return;
		}
		if (nextMode === displayedMedia.selectedMode) {
			return;
		}
		await requestTokenDetailMedia(nextMode, null);
	}

	async function setTokenDetailMediaVariant(nextVariant: string): Promise<void> {
		if (!browser || !data?.chain || !data.collection || !displayedToken) {
			return;
		}
		if (
			tokenDetailMediaPending ||
			!hasMediaVariantChoices() ||
			nextVariant === displayedMedia.selectedVariant ||
			!displayedMedia.availableVariants.some((variant) => variant.key === nextVariant)
		) {
			return;
		}
		await requestTokenDetailMedia(displayedMedia.selectedMode, nextVariant);
	}

	async function requestTokenDetailMedia(
		mediaMode: string,
		mediaVariant: string | null
	): Promise<void> {
		if (
			!browser ||
			!data?.chain ||
			!data.collection ||
			!displayedToken ||
			tokenDetailMediaPending
		) {
			return;
		}

		const activeRequestId = ++tokenDetailRequestId;
		tokenDetailMediaPending = true;
		tokenDetailMediaError = null;
		failedTokenDetailMediaRequest = null;
		// Keep the requested source and version visible if the request needs recovery.
		markTokenDetailMediaRequestPending(mediaMode, mediaVariant);

		try {
			// Fetch the selected source and media version together so the controls match the media.
			const response = await getTokenDetail(
				fetch,
				data.chain.slug,
				data.collection.slug,
				displayedToken.tokenId,
				buildTokenMediaQuery({
					mediaMode,
					mediaPreference: displayedMedia.preference,
					mediaVariant
				})
			);
			if (activeRequestId !== tokenDetailRequestId) return;

			displayedToken = response.token;
			displayedMedia = response.media;
		} catch {
			if (activeRequestId !== tokenDetailRequestId) return;
			failedTokenDetailMediaRequest = { mediaMode, mediaVariant };
			tokenDetailMediaError = 'Unable to load media.';
		} finally {
			if (activeRequestId === tokenDetailRequestId) {
				tokenDetailMediaPending = false;
			}
		}
	}

	function markTokenDetailMediaRequestPending(
		mediaMode: string,
		mediaVariant: string | null
	): void {
		const retainsKnownSourceOptions = displayedMedia.selectedMode === mediaMode;
		displayedMedia = {
			...displayedMedia,
			selectedMode: mediaMode,
			selectedVariant:
				mediaVariant ?? (retainsKnownSourceOptions ? displayedMedia.selectedVariant : null),
			defaultVariant: retainsKnownSourceOptions ? displayedMedia.defaultVariant : null,
			availableVariants: retainsKnownSourceOptions ? displayedMedia.availableVariants : []
		};
	}

	async function retryTokenDetailMedia(): Promise<void> {
		const request = failedTokenDetailMediaRequest;
		if (!request) return;
		await requestTokenDetailMedia(request.mediaMode, request.mediaVariant);
	}

	async function refreshTokenBiddingData(): Promise<void> {
		if (!browser || !data?.chain || !data.collection || !displayedToken) {
			return;
		}

		const activeTokenId = displayedToken.tokenId;
		const requestId = tokenBiddingRefreshRequestId + 1;
		tokenBiddingRefreshRequestId = requestId;
		const anchor = captureBiddingLiveRefreshAnchor(tokenBiddingContentElement);

		try {
			// Refresh the token-scoped job and bid book together so the panel and rows stay coherent.
			const [jobResponse, bidBookResponse] = await Promise.all([
				getTokenBiddingJob(fetch, data.chain.slug, data.collection.slug, activeTokenId),
				getTokenBiddingBidBook(fetch, data.chain.slug, data.collection.slug, activeTokenId)
			]);
			if (
				tokenBiddingRefreshRequestId !== requestId ||
				displayedToken?.tokenId !== activeTokenId ||
				jobResponse.tokenId !== activeTokenId ||
				bidBookResponse.tokenId !== activeTokenId
			) {
				return;
			}
			tokenBiddingJob = jobResponse.job;
			tokenBiddingBidBook = bidBookResponse.bidBook;
			await tick();
			if (tokenBiddingRefreshRequestId === requestId) {
				restoreBiddingLiveRefreshAnchor(tokenBiddingContentElement, anchor);
			}
		} catch {
			// Keep the current token bidding view visible after transient refresh failures.
		}
	}

	function onWindowKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented) return;
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if (isKeyboardTextEntryTarget(event.target)) return;
		if (event.key !== 'v' && event.key !== 'V') return;
		if (!hasMediaVariantChoices() || !displayedMedia.selectedVariant) return;
		event.preventDefault();
		void setTokenDetailMediaVariant(
			nextMediaOption(displayedMedia.availableVariants, displayedMedia.selectedVariant)
		);
	}

	function resolveInitialMediaState(
		input: ApiTokenMediaState | null | undefined
	): ApiTokenMediaState {
		if (input) return input;
		return {
			selectedMode: COLLECTION_MEDIA_MODES.Snapshot,
			defaultMode: COLLECTION_MEDIA_MODES.Snapshot,
			availableModes: [
				COLLECTION_MEDIA_MODE_OPTIONS.Snapshot
			],
			preference: null,
			selectedVariant: null,
			defaultVariant: null,
			availableVariants: []
		};
	}

</script>

<svelte:window onkeydown={onWindowKeydown} />

<section class="panel token-detail-panel" bind:this={tokenBiddingContentElement}>
	{#if displayedToken}
		{@const iframeSource = tokenMediaSource(displayedToken)}
		<div class="token-detail-media-region">
			<div class="token-detail-media-wrap" style={tokenDetailMediaStyle()}>
				{#if iframeSource}
					<TokenMediaFrame
						className="token-detail-media-frame"
						{iframeSource}
						title={tokenMediaTitle(displayedToken.tokenId)}
					/>
				{:else}
					<div class="token-detail-empty muted">no media available</div>
				{/if}
			</div>
			{#if hasMediaSourceChoices() || hasMediaVariants()}
				<div class="token-detail-media-controls" aria-busy={tokenDetailMediaPending}>
					{#if shouldRenderMediaSourceRow()}
						<div class="secondary-tabs" aria-label="Token detail source">
							{#each displayedMedia.availableModes as mode}
								{#if mode.key === displayedMedia.selectedMode}
									<span class="secondary-tab-active">{mode.label}</span>
								{:else}
									<button
										type="button"
										disabled={tokenDetailMediaPending}
										onclick={() => void setTokenDetailMediaMode(mode.key)}
									>
										{mode.label}
									</button>
								{/if}
							{/each}
						</div>
					{/if}

					{#if hasMediaVariants()}
						<div class="secondary-tabs" aria-label="Token detail media version">
							{#each displayedMedia.availableVariants as variant}
								{#if variant.key === displayedMedia.selectedVariant}
									<span class="secondary-tab-active">{variant.label}</span>
								{:else}
									<button
										type="button"
										disabled={tokenDetailMediaPending}
										onclick={() => void setTokenDetailMediaVariant(variant.key)}
									>
										{variant.label}
									</button>
								{/if}
							{/each}
						</div>
					{/if}
					{#if tokenDetailMediaPending}
						<LoadingBladeBar ariaLabel="loading token media" barLength={1} />
					{/if}
				</div>
			{/if}
			{#if tokenDetailMediaError}
				<TokenDetailMediaError
					message={tokenDetailMediaError}
					onRetry={() => void retryTokenDetailMedia()}
				/>
			{/if}
		</div>

		<h1 class="token-detail-title">{resolveTokenTitle(displayedToken, data?.collection ?? null)}</h1>

		<section class="panel-header token-detail-meta">
			{#if openseaItemHref()}
				<div class="token-detail-meta-block token-grid-price">
					<a
						class="mono token-detail-meta-value token-price-link"
						href={openseaItemHref() ?? '#'}
						target="_blank"
						rel="noreferrer noopener"
					>
						{openseaLinkLabel()}
					</a>
				</div>
			{/if}
            <div class="token-detail-meta-block">
				<p class="muted token-detail-meta-label">current holder:</p>
				{#if holderHref()}
					<a class="mono token-detail-meta-value" href={holderHref() ?? '#'}
						>{displayedToken.currentHolder}</a
					>
				{:else}
					<span class="mono token-detail-meta-value">{displayedToken.currentHolder ?? '-'}</span>
				{/if}
			</div>
		</section>

		{@const extensionSections = tokenDetailExtensionSections()}
		{#if data?.chain && data.collection && extensionSections.length > 0}
			<div class="token-detail-extension-sections">
				{#each extensionSections as section (`${section.extensionKey}:${section.sectionId}`)}
					<TokenDetailExtensionSectionOutlet
						Section={section.Section}
						chain={data.chain}
						collection={data.collection}
						token={displayedToken}
						media={displayedMedia}
						hrefs={tokenDetailExtensionHrefs()}
					/>
				{/each}
			</div>
		{/if}

		<div class="token-detail-traits-wrap">
			{#if sortedTraits().length === 0}
				<p class="muted">no traits available</p>
			{:else}
				<table class="token-detail-traits">
					<thead>
						<tr>
							<th class="token-detail-col-center">trait</th>
							<th class="token-detail-col-center">value</th>
							<th class="token-detail-col-right">count</th>
							<th class="token-detail-col-right">rarity</th>
						</tr>
					</thead>
						<tbody>
							{#each sortedTraits() as trait}
								{@const traitHref = traitValueHref(trait)}
								<tr>
									<td class="mono token-detail-col-center">{trait.key}</td>
									<td class="mono token-detail-col-center">
										<span class="token-detail-trait-value">
											{#if traitHref}
												<a href={traitHref}>{trait.value}</a>
											{:else}
												<span>{trait.value}</span>
											{/if}
											{#if shouldShowTokenBiddingAutomation()}
												<button
													type="button"
													class="bid-book-place-bid-icon-button token-detail-trait-bid-button"
													aria-label={tokenTraitBidLabel(trait)}
													title={tokenTraitBidLabel(trait)}
													onclick={() => bidOnTokenTrait(trait)}
												>
													<PlaceBidIcon className="bid-book-place-bid-icon" />
												</button>
											{/if}
										</span>
									</td>
									<td class="mono token-detail-col-right">{formatTraitCount(trait.tokenCount)}</td>
									<td class="mono token-detail-col-right">{formatRarityPercent(trait.rarityPercent)}</td>
								</tr>
							{/each}
					</tbody>
				</table>
			{/if}
		</div>

		{#if shouldShowTokenBidBook()}
			{#if shouldShowTokenBiddingAutomation()}
				<div class="panel-top-actions-row token-detail-bidding-actions">
					<button
						type="button"
						class="facet-panel-action-button bidding-select-all-button"
						onclick={bidOnDisplayedToken}
					>
						{BIDDING_SELECTION_ACTION_LABEL.BidOnToken}
					</button>
				</div>
			{/if}
			<BidBookPanel
				bidBook={tokenBiddingBidBook}
				job={tokenBiddingJob}
				nextUpdateAtMs={tokenBiddingNextUpdateAtMs}
				showScope
				showOwnStateBadges={false}
				showMuted={data?.showMuted ?? false}
				basePath={collectionTokensBasePath()}
				mediaMode={collectionNavigationMediaMode()}
				mediaPreference={displayedMedia.preference}
				traitValueHref={bidBookTraitValueHref}
				makerBidHref={bidBookMakerHref}
				onFilterTraitDemandGroup={onBidBookTraitFilter}
				canSelectBid={canSelectTokenDetailBidBookBid}
				onSelectBid={IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT ? null : onBidBookSelectBid}
				showRowActions={false}
			/>
		{/if}

		{#if shouldShowTokenBiddingAutomation()}
			<BiddingAutomationPanel
				open={tokenBiddingPanelOpen}
				chain={data?.chain ?? null}
				collection={data?.collection ?? null}
				token={displayedToken}
				job={tokenBiddingJob}
				draft={tokenBiddingDraft}
				bidBook={tokenBiddingBidBook}
				biddingSettings={data?.biddingSettings ?? defaultBiddingCollectionSettings()}
				priceTiers={data?.priceTiers ?? []}
				trustOpenSeaSignedZoneTraitOffers={data?.trustOpenSeaSignedZoneTraitOffers}
				expandSignal={tokenBiddingPanelExpandSignal}
				showCollapsedLauncher={false}
				onClose={closeTokenBiddingPanel}
				onJobChange={onTokenBiddingJobChange}
				onJobsChange={onTokenBiddingJobsChange}
			/>
		{/if}
	{:else}
		<section class="panel-header">
			<span class="muted">token not found</span>
		</section>
	{/if}

	<header class="panel-header token-detail-header">
		<a class="button-link" href={collectionHref()}>{backLabel()}</a>
	</header>
</section>
