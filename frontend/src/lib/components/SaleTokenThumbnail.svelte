<script lang="ts">
	import type { SaleMediaLoader, SalePreviewTarget } from '$lib/price-chart/media';
	let {
		tokenId,
		href,
		loader,
		onpreview
	}: {
		tokenId: string;
		href: string;
		loader: SaleMediaLoader;
		onpreview: (target: SalePreviewTarget | null) => void;
	} = $props();
	let image = $state<string | null>(null);
	$effect(() => {
		let cancelled = false;
		image = null;
		void loader.load(tokenId).then((media) => {
			if (!cancelled) image = media?.image ?? null;
		});
		return () => {
			cancelled = true;
		};
	});
	function preview(event: MouseEvent | FocusEvent) {
		const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
		onpreview({ tokenId, x: rect.left, y: rect.bottom, count: 1 });
	}
</script>

<a class="sale-thumbnail" {href} aria-label={`Token #${tokenId}`} onmouseenter={preview} onmouseleave={() => onpreview(null)} onfocus={preview} onblur={() => onpreview(null)} onclick={() => onpreview(null)}>
	{#if image}<img src={image} alt="" referrerpolicy="no-referrer" onerror={() => image = null} />{:else}<span>·</span>{/if}
</a>
<style>
	.sale-thumbnail {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		border: 1px solid var(--c-blue);
		overflow: hidden;
	}
	img {
		width: 100%;
		height: 100%;
		object-fit: contain;
	}
</style>
