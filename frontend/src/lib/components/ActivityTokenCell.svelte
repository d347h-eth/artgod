<script lang="ts">
	import type { ApiTokenPresentationSummary } from '$lib/api-types';
	import type { TokenPreviewController } from '$lib/components/token-preview-controller';

	let {
		chainRef,
		collectionRef,
		tokenId,
		token,
		tokenPreview
	}: {
		chainRef: string | null;
		collectionRef: string | null;
		tokenId: string | null;
		token: ApiTokenPresentationSummary | null;
		tokenPreview: TokenPreviewController;
	} = $props();
	let tokenAspectRatio = $state<number | null>(null);

	async function onOpenTokenPreview(): Promise<void> {
		if (!chainRef || !collectionRef || !tokenId) return;
		await tokenPreview.openTokenPreview({
			chainRef,
			collectionRef,
			tokenId
		});
	}

	function onTokenImageLoad(event: Event): void {
		const target = event.currentTarget;
		if (!(target instanceof HTMLImageElement)) return;
		if (target.naturalWidth <= 0 || target.naturalHeight <= 0) return;

		const ratio = target.naturalWidth / target.naturalHeight;
		if (!Number.isFinite(ratio) || ratio <= 0 || tokenAspectRatio === ratio) return;
		tokenAspectRatio = ratio;
	}

	function tokenPreviewStyle(): string | undefined {
		if (!Number.isFinite(tokenAspectRatio) || tokenAspectRatio === null || tokenAspectRatio <= 0) {
			return undefined;
		}
		return `--token-grid-media-ar:${tokenAspectRatio};`;
	}
</script>

<div class="activity-token-cell">
	{#if tokenId && token?.image}
		<div class="token-grid-media activity-token-media">
			<button
				type="button"
				class="token-preview-trigger token-preview-trigger-grid activity-token-preview"
				style={tokenPreviewStyle()}
				aria-label={tokenPreview.tokenPreviewAriaLabel(tokenId)}
				onclick={() => void onOpenTokenPreview()}
			>
				<img
					class="token-grid-thumb activity-token-thumb"
					src={token.image}
					alt={`token ${tokenId}`}
					loading="lazy"
					decoding="async"
					referrerpolicy="no-referrer"
					onload={onTokenImageLoad}
				/>
			</button>
		</div>
	{:else}
		<div class="token-grid-media activity-token-media">
			<div class="token-grid-thumb token-grid-thumb-empty token-thumb-empty activity-token-thumb-empty">
				-
			</div>
		</div>
	{/if}
</div>
