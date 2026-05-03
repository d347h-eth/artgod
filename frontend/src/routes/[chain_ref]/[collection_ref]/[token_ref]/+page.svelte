<script lang="ts">
	import { browser } from '$app/environment';
	import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
	import { COLLECTION_MEDIA_MODES } from '@artgod/shared/extensions';
	import {
		resolveTraitFilterDisplayKind,
		TRAIT_FILTER_DISPLAY_KIND
	} from '@artgod/shared/types';
	import BidBookPanel from '$lib/components/BidBookPanel.svelte';
	import TokenMediaFrame from '$lib/components/TokenMediaFrame.svelte';
	import TokenBiddingJobForm from '$lib/components/TokenBiddingJobForm.svelte';
	import type {
		ApiBiddingBidBook,
		ApiBiddingJob,
		ApiChain,
		ApiCollection,
		ApiCollectionMediaState,
		ApiTraitFilterPresentationFeatureState,
		ApiTokenDetail,
		ApiTokenDetailTrait
	} from '$lib/api-types';
	import { getTokenDetail } from '$lib/backend-api';
	import { buildCollectionBiddingHref } from '$lib/bidding-query';
	import { formatListingPrice } from '$lib/listing-price';
	import { openseaItemHref as buildOpenseaItemHref } from '$lib/marketplace-links';
	import { appendMediaModeParam, nextMediaMode } from '$lib/media-mode';
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

	type PageData = {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		media: ApiCollectionMediaState;
		token: ApiTokenDetail | null;
		traitFilterPresentation?: ApiTraitFilterPresentationFeatureState;
		tokenBiddingJob?: ApiBiddingJob | null;
		tokenBiddingBidBook?: ApiBiddingBidBook;
		showMuted?: boolean;
		backPath: string | null;
		backQuery: string | null;
	};

	let { data }: { data?: PageData } = $props();
	let displayedToken = $state<ApiTokenDetail | null>(data?.token ?? null);
	let displayedMedia = $state<ApiCollectionMediaState>(resolveInitialMediaState(data?.media));
	let displayedMediaAspectRatio = $state<number | null>(null);
	let tokenDetailRequestId = 0;

	$effect(() => {
		displayedToken = data?.token ?? null;
		displayedMedia = resolveInitialMediaState(data?.media);
		displayedMediaAspectRatio = null;
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
		appendMediaModeParam(query, collectionNavigationMediaMode());
		const suffix = query.toString();
		return suffix ? `${base}?${suffix}` : base;
	}

	function holderHref(): string | null {
		if (!data?.chain || !data.collection || !displayedToken?.currentHolder) return null;
		if (IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) {
			const query = new URLSearchParams();
			appendMediaModeParam(query, collectionNavigationMediaMode());
			const suffix = query.toString();
			const path = publicCollectionOwnerTokensPath(displayedToken.currentHolder);
			return suffix ? `${path}?${suffix}` : path;
		}
		return buildOwnerTokensHref({
			basePath: `/${data.chain.slug}/${data.collection.slug}/holders/${encodeURIComponent(displayedToken.currentHolder)}`,
			selectedTraits: [],
			selectedTraitRanges: [],
			mediaMode: collectionNavigationMediaMode()
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

	function collectionBiddingHref(): string {
		return buildCollectionBiddingHref({
			basePath: collectionTokensBasePath(),
			selectedTraits: [],
			selectedTraitRanges: [],
			mediaMode: collectionNavigationMediaMode(),
			showMuted: data?.showMuted ?? false
		});
	}

	function shouldShowTokenBiddingForm(): boolean {
		return !IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT && !!data?.chain && !!data.collection && !!displayedToken;
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

	function hasMediaModeChoices(): boolean {
		return displayedMedia.availableModes.length > 1;
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
		if (displayedMedia.selectedMode === COLLECTION_MEDIA_MODES.Artifact) {
			return displayedMedia.selectedMode;
		}
		if (displayedMedia.selectedMode === COLLECTION_MEDIA_MODES.Snapshot) {
			return displayedMedia.selectedMode;
		}
		return displayedMedia.defaultMode;
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
			mediaMode: collectionNavigationMediaMode()
		});
	}

	async function setTokenDetailMediaMode(nextMode: string): Promise<void> {
		if (!browser || !data?.chain || !data.collection || !displayedToken) {
			return;
		}
		if (!hasMediaModeChoices()) {
			return;
		}
		if (nextMode === displayedMedia.selectedMode) {
			return;
		}

		const activeRequestId = ++tokenDetailRequestId;

		try {
			const response = await getTokenDetail(
				fetch,
				data.chain.slug,
				data.collection.slug,
				displayedToken.tokenId,
				buildMediaModeQuery(nextMode)
			);
			if (activeRequestId !== tokenDetailRequestId) return;

			displayedToken = response.token;
			displayedMedia = response.media;
		} catch {
			if (activeRequestId !== tokenDetailRequestId) return;
		}
	}

	function onWindowKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented) return;
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if (isTypingTarget(event.target)) return;
		if (event.key !== 'v' && event.key !== 'V') return;
		if (!hasMediaModeChoices()) return;
		event.preventDefault();
		void setTokenDetailMediaMode(
			nextMediaMode(displayedMedia.availableModes, displayedMedia.selectedMode)
		);
	}

	function buildMediaModeQuery(mediaMode: string | null): URLSearchParams {
		const query = new URLSearchParams();
		appendMediaModeParam(query, mediaMode);
		return query;
	}

	function resolveInitialMediaState(input: ApiCollectionMediaState | null | undefined): ApiCollectionMediaState {
		if (input) return input;
		return {
			selectedMode: 'snapshot',
			defaultMode: 'snapshot',
			availableModes: [{ key: 'snapshot', label: 'snapshot' }]
		};
	}

	function isTypingTarget(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) return false;
		if (target.isContentEditable) return true;
		const tag = target.tagName.toLowerCase();
		return tag === 'input' || tag === 'textarea' || tag === 'select';
	}

	function emptyBidBook(): ApiBiddingBidBook {
		return {
			state: {
				source: 'orders',
				snapshotRefreshedAtMs: null,
				projectedAt: null,
				rowCount: 0,
				durationMs: null,
				lastError: null
			},
			bids: []
		};
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

<section class="panel token-detail-panel">
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
			{#if hasMediaModeChoices()}
				<div class="token-detail-media-controls">
					<div class="secondary-tabs" aria-label="Token detail media mode">
						{#each displayedMedia.availableModes as mode}
							{#if mode.key === displayedMedia.selectedMode}
								<span class="secondary-tab-active">{mode.label}</span>
							{:else}
								<button type="button" onclick={() => void setTokenDetailMediaMode(mode.key)}>
									{mode.label}
								</button>
							{/if}
						{/each}
					</div>
				</div>
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
										{#if traitHref}
											<a href={traitHref}>{trait.value}</a>
										{:else}
											{trait.value}
										{/if}
									</td>
									<td class="mono token-detail-col-right">{formatTraitCount(trait.tokenCount)}</td>
									<td class="mono token-detail-col-right">{formatRarityPercent(trait.rarityPercent)}</td>
								</tr>
							{/each}
					</tbody>
				</table>
			{/if}
		</div>

		{#if shouldShowTokenBiddingForm()}
				<BidBookPanel
					bidBook={data?.tokenBiddingBidBook ?? emptyBidBook()}
					job={data?.tokenBiddingJob ?? null}
					showScope
					showMuted={data?.showMuted ?? false}
					basePath={collectionTokensBasePath()}
					mediaMode={collectionNavigationMediaMode()}
				/>
			<TokenBiddingJobForm
				chain={data?.chain ?? null}
				collection={data?.collection ?? null}
				token={displayedToken}
				job={data?.tokenBiddingJob ?? null}
				bidBook={data?.tokenBiddingBidBook ?? emptyBidBook()}
				collectionBiddingHref={collectionBiddingHref()}
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
