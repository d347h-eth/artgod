<script lang="ts">
	import { browser } from '$app/environment';
	import type {
		ApiChain,
		ApiCollection,
		ApiCollectionMediaState,
		ApiTokenDetail,
		ApiTokenDetailTrait
	} from '$lib/api-types';
	import { getTokenDetail } from '$lib/backend-api';
	import { appendMediaModeParam, mediaModeLabel, nextMediaMode } from '$lib/media-mode';
	import {
		IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
		publicCollectionOwnerTokensPath,
		publicCollectionTokensPath
	} from '$lib/runtime/public-deployment';
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
	let tokenDetailRequestId = 0;

	$effect(() => {
		displayedToken = data?.token ?? null;
		displayedMedia = resolveInitialMediaState(data?.media);
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

	function mediaKind(token: ApiTokenDetail): 'iframe' | 'image' | 'none' {
		if (token.animationUrl) return 'iframe';
		if (token.image) return 'image';
		return 'none';
	}

	function formatTraitCount(value: number | null): string {
		if (value === null) return '-';
		return String(value);
	}

	function formatRarityPercent(value: number | null): string {
		if (value === null) return '-';
		return `${value.toFixed(2)}%`;
	}

	function mediaModeButtonLabel(): string | null {
		if (displayedMedia.availableModes.length <= 1) {
			return null;
		}
		return mediaModeLabel(displayedMedia.availableModes, displayedMedia.selectedMode);
	}

	async function cycleTokenDetailMediaMode(): Promise<void> {
		if (!browser || !data?.chain || !data.collection || !displayedToken) {
			return;
		}
		if (displayedMedia.availableModes.length <= 1) {
			return;
		}

		const nextMode = nextMediaMode(displayedMedia.availableModes, displayedMedia.selectedMode);
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
		if (displayedMedia.availableModes.length <= 1) return;
		event.preventDefault();
		void cycleTokenDetailMediaMode();
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
	<header class="panel-header">
		<a class="button-link" href={collectionHref()}>{backLabel()}</a>
	</header>

	{#if displayedToken}
		<div class="token-detail-media-wrap">
			{#if mediaModeButtonLabel()}
				<button
					type="button"
					class="token-preview-media-mode-button"
					onclick={() => void cycleTokenDetailMediaMode()}
				>
					{mediaModeButtonLabel()}
				</button>
			{/if}
			{#if mediaKind(displayedToken) === 'iframe'}
				<iframe
					class="token-detail-media-frame"
					src={displayedToken.animationUrl ?? ''}
					title={`token ${displayedToken.tokenId}`}
					sandbox="allow-scripts"
					referrerpolicy="no-referrer"
				></iframe>
			{:else if mediaKind(displayedToken) === 'image'}
				<img
					class="token-detail-media-image"
					src={displayedToken.image ?? ''}
					alt={`token ${displayedToken.tokenId}`}
					loading="eager"
					decoding="async"
					referrerpolicy="no-referrer"
				/>
			{:else}
				<div class="token-detail-empty muted">no media available</div>
			{/if}
		</div>

		<h1 class="token-detail-title">{resolveTokenTitle(displayedToken, data?.collection ?? null)}</h1>

		<section class="panel-header">
			{#if holderHref()}
				<p class="muted">
					current holder
					<a class="mono" href={holderHref() ?? '#'}>{displayedToken.currentHolder}</a>
				</p>
			{:else}
				<p class="muted">current holder <span class="mono">{displayedToken.currentHolder ?? '-'}</span></p>
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
</section>
