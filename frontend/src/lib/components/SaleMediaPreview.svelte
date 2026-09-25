<script lang="ts">
	import TokenMediaFrame from '$lib/components/TokenMediaFrame.svelte';
	import { resolveTokenMediaIframeSource, tokenMediaTitle } from '$lib/token-media';
	import type { SaleMedia, SaleMediaLoader, SalePreviewTarget } from '$lib/price-chart/media';
	let { target, loader }: { target: SalePreviewTarget; loader: SaleMediaLoader } = $props();
	let media = $state.raw<SaleMedia | null>(null);
	let loading = $state(true);
	let viewportWidth = $state(0),
		viewportHeight = $state(0);
	const previewTokenId = $derived(target.tokenId);
	const size = $derived(Math.max(96, Math.min(240, viewportWidth - 24, viewportHeight - 60)));
	const left = $derived(
		Math.max(
			8,
			Math.min(
				target.x + 14 + size > viewportWidth ? target.x - size - 14 : target.x + 14,
				viewportWidth - size - 8
			)
		)
	);
	const top = $derived(Math.max(8, Math.min(target.y + 14, viewportHeight - size - 40)));
	const source = $derived(
		media
			? resolveTokenMediaIframeSource(
					media.animationUrl,
					media.image,
					tokenMediaTitle(target.tokenId)
				)
			: null
	);
	$effect(() => {
		const id = previewTokenId;
		let cancelled = false;
		media = null;
		loading = true;
		void loader.load(id, true).then((result) => {
			if (cancelled) return;
			media = result;
			loading = false;
		});
		return () => {
			cancelled = true;
		};
	});
</script>

<svelte:window bind:innerWidth={viewportWidth} bind:innerHeight={viewportHeight} />
<div class="sale-media-preview" role="tooltip" aria-label={`Preview token ${target.tokenId}`} style:left={`${left}px`} style:top={`${top}px`} style:width={`${size}px`}>
	<div class="sale-preview-media" style:height={`${size}px`}>
		{#if source}
			<TokenMediaFrame iframeSource={source} title={tokenMediaTitle(target.tokenId)} className="sale-preview-frame" hideScrollbars />
		{:else}<span class="muted">{loading ? 'loading…' : media ? 'no preview' : 'hover again to retry'}</span>{/if}
	</div>
	<div class="sale-preview-caption">token #{target.tokenId}{#if target.count > 1} · {target.count} sales{/if}</div>
</div>

<style>
	.sale-media-preview {
		position: fixed;
		z-index: 80;
		pointer-events: none;
		border: 1px solid var(--c-blue);
		background: var(--c-bg);
		color: var(--c-ice);
	}
	.sale-preview-media {
		display: grid;
		place-items: center;
		width: 100%;
	}
	.sale-preview-media :global(.sale-preview-frame) {
		width: 100%;
		height: 100%;
		border: 0;
	}
	.sale-preview-caption {
		padding: 0.3rem;
		font-size: 0.7rem;
	}
</style>
