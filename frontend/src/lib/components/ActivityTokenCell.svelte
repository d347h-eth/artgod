<script lang="ts">
	import type {
		ApiCollectionMediaMode,
		ApiCollectionMediaPreference,
		ApiTokenPresentationSummary
	} from '$lib/api-types';
	import TokenMediaPreviewTrigger from '$lib/components/TokenMediaPreviewTrigger.svelte';
	import type { TokenPreviewContext, TokenPreviewController } from '$lib/components/token-preview-controller';

	let {
		chainRef,
		collectionRef,
		tokenId,
		token,
		imageOverride = null,
		selectedMediaMode,
		availableMediaModes,
		mediaPreference = null,
		previewContext = null,
		tokenPreview
	}: {
		chainRef: string | null;
		collectionRef: string | null;
		tokenId: string | null;
		token: ApiTokenPresentationSummary | null;
		imageOverride?: string | null;
		selectedMediaMode: string;
		availableMediaModes: ApiCollectionMediaMode[];
		mediaPreference?: ApiCollectionMediaPreference | null;
		previewContext?: TokenPreviewContext | null;
		tokenPreview: TokenPreviewController;
	} = $props();
</script>

<div class="activity-token-cell">
	<TokenMediaPreviewTrigger
		{chainRef}
		{collectionRef}
		{tokenId}
		image={imageOverride ?? token?.image ?? null}
		{selectedMediaMode}
		{availableMediaModes}
		{mediaPreference}
		{previewContext}
		{tokenPreview}
		mode="grid"
		containerClass="token-grid-media activity-token-media"
		imageClass="token-grid-thumb"
		emptyClass="token-grid-thumb token-grid-thumb-empty token-thumb-empty"
	/>
</div>
