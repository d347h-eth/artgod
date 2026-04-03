<script lang="ts">
	import { browser } from '$app/environment';
	import TokenMediaFrame from '$lib/components/TokenMediaFrame.svelte';
	import type {
		ApiChain,
		ApiCollection,
		ApiCollectionMediaState,
		ApiTokenDetail,
		ApiTokenDetailTrait
	} from '$lib/api-types';
	import { getTokenDetail } from '$lib/backend-api';
	import { formatListingPrice } from '$lib/listing-price';
	import { openseaItemHref as buildOpenseaItemHref } from '$lib/marketplace-links';
	import { appendMediaModeParam, nextMediaMode } from '$lib/media-mode';
	import {
		IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
		publicCollectionOwnerTokensPath,
		publicCollectionTokensPath
	} from '$lib/runtime/public-deployment';
	import {
		resolveTokenMediaAspectRatio,
		resolveTokenMediaIframeSource,
		tokenMediaTitle,
		type TokenMediaIframeSource
	} from '$lib/token-media';
	import { buildOwnerTokensHref } from '$lib/token-browser-query';

	type PageData = {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		media: ApiCollectionMediaState;
		token: ApiTokenDetail | null;
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
		appendMediaModeParam(query, data.media?.selectedMode ?? null);
		const suffix = query.toString();
		return suffix ? `${base}?${suffix}` : base;
	}

	function holderHref(): string | null {
		if (!data?.chain || !data.collection || !displayedToken?.currentHolder) return null;
		if (IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) {
			const query = new URLSearchParams();
			appendMediaModeParam(query, data.media?.selectedMode ?? null);
			const suffix = query.toString();
			const path = publicCollectionOwnerTokensPath(displayedToken.currentHolder);
			return suffix ? `${path}?${suffix}` : path;
		}
		return buildOwnerTokensHref({
			basePath: `/${data.chain.slug}/${data.collection.slug}/holders/${encodeURIComponent(displayedToken.currentHolder)}`,
			selectedTraits: [],
			selectedTraitRanges: [],
			mediaMode: data.media?.selectedMode ?? null
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
			return data.backPath && data.backPath !== publicCollectionTokensPath()
				? 'back to holder'
				: 'back to collection';
		}
		return data.backPath && data.backPath !== collectionPath ? 'back to holder' : 'back to collection';
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
							<tr>
								<td class="mono token-detail-col-center">{trait.key}</td>
								<td class="mono token-detail-col-center">{trait.value}</td>
								<td class="mono token-detail-col-right">{formatTraitCount(trait.tokenCount)}</td>
								<td class="mono token-detail-col-right">{formatRarityPercent(trait.rarityPercent)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</div>
	{:else}
		<section class="panel-header">
			<span class="muted">token not found</span>
		</section>
	{/if}

	<header class="panel-header token-detail-header">
		<a class="button-link" href={collectionHref()}>{backLabel()}</a>
	</header>
</section>
