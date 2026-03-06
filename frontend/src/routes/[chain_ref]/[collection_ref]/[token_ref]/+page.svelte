<script lang="ts">
	import type {
		ApiChain,
		ApiCollection,
		ApiTokenDetail,
		ApiTokenDetailTrait
	} from '$lib/api-types';

	type PageData = {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		token: ApiTokenDetail | null;
		backCursor: string | null;
	};

	let { data }: { data?: PageData } = $props();

	function collectionHref(): string {
		if (!data?.chain || !data.collection) return '/';
		const base = `/${data.chain.slug}/${data.collection.slug ?? data.collection.address}`;
		if (!data.backCursor) return base;
		const query = new URLSearchParams();
		query.set('cursor', data.backCursor);
		return `${base}?${query.toString()}`;
	}

	function sortedTraits(): ApiTokenDetailTrait[] {
		const input = data?.token?.attributes ?? [];
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
</script>

<section class="panel token-detail-panel">
	<header class="panel-header">
		<a class="button-link" href={collectionHref()}>back to collection</a>
	</header>

	{#if data?.token}
		<div class="token-detail-media-wrap">
			{#if mediaKind(data.token) === 'iframe'}
				<iframe
					class="token-detail-media-frame"
					src={data.token.animationUrl ?? ''}
					title={`token ${data.token.tokenId}`}
					sandbox="allow-scripts"
					referrerpolicy="no-referrer"
				></iframe>
			{:else if mediaKind(data.token) === 'image'}
				<img
					class="token-detail-media-image"
					src={data.token.image ?? ''}
					alt={`token ${data.token.tokenId}`}
					loading="eager"
					decoding="async"
					referrerpolicy="no-referrer"
				/>
			{:else}
				<div class="token-detail-empty muted">no media available</div>
			{/if}
		</div>

		<h1 class="token-detail-title">{resolveTokenTitle(data.token, data.collection ?? null)}</h1>

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
