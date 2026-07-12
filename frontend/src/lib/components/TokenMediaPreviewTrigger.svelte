<script lang="ts">
	import type { ApiCollectionMediaMode, ApiCollectionMediaPreference } from '$lib/api-types';
	import type {
		TokenPreviewAdjacentResolver,
		TokenPreviewContext,
		TokenPreviewController
	} from '$lib/components/token-preview-controller';

	let {
		chainRef,
		collectionRef,
		tokenId,
		image,
		selectedMediaMode,
		availableMediaModes,
		mediaPreference = null,
		tokenPreview,
		previewContext = null,
		adjacentTokenResolver = null,
		mode = 'grid',
		containerClass,
		imageClass,
		emptyClass
	}: {
		chainRef: string | null;
		collectionRef: string | null;
		tokenId: string | null;
		image: string | null;
		selectedMediaMode: string;
		availableMediaModes: ApiCollectionMediaMode[];
		mediaPreference?: ApiCollectionMediaPreference | null;
		tokenPreview: TokenPreviewController;
		previewContext?: TokenPreviewContext | null;
		adjacentTokenResolver?: TokenPreviewAdjacentResolver | null;
		mode?: 'grid' | 'inline';
		containerClass?: string;
		imageClass: string;
		emptyClass: string;
	} = $props();

	let tokenAspectRatio = $state<number | null>(null);

	async function onOpenTokenPreview(): Promise<void> {
		if (!chainRef || !collectionRef || !tokenId) return;
		await tokenPreview.openTokenPreview({
			chainRef,
			collectionRef,
			tokenId,
			selectedMediaMode,
			availableMediaModes,
			mediaPreference,
			previewContext,
			previewAspectRatio: tokenAspectRatio,
			adjacentTokenResolver
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

	function previewTriggerClass(): string {
		return `token-preview-trigger ${mode === 'grid' ? 'token-preview-trigger-grid' : 'token-preview-trigger-inline'}`;
	}

	function previewTriggerStyle(): string | undefined {
		if (mode !== 'grid') return undefined;
		if (!Number.isFinite(tokenAspectRatio) || tokenAspectRatio === null || tokenAspectRatio <= 0) {
			return undefined;
		}
		return `--token-grid-media-ar:${tokenAspectRatio};`;
	}
</script>

<div class={containerClass}>
	{#if tokenId && image}
		<button
			type="button"
			class={previewTriggerClass()}
			style={previewTriggerStyle()}
			aria-label={tokenPreview.tokenPreviewAriaLabel(tokenId)}
			onclick={() => void onOpenTokenPreview()}
		>
			<img
				class={imageClass}
				src={image}
				alt={`token ${tokenId}`}
				loading="lazy"
				decoding="async"
				referrerpolicy="no-referrer"
				onload={onTokenImageLoad}
			/>
		</button>
	{:else}
		<div class={emptyClass}>-</div>
	{/if}
</div>
