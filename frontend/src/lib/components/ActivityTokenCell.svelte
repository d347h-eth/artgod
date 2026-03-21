<script lang="ts">
	import type { ApiTokenPresentationSummary } from '$lib/api-types';
	import TokenMediaPreviewTrigger from '$lib/components/TokenMediaPreviewTrigger.svelte';
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
</script>

<div class="activity-token-cell">
	<TokenMediaPreviewTrigger
		{chainRef}
		{collectionRef}
		{tokenId}
		image={token?.image ?? null}
		{tokenPreview}
		mode="grid"
		containerClass="token-grid-media activity-token-media"
		imageClass="token-grid-thumb"
		emptyClass="token-grid-thumb token-grid-thumb-empty token-thumb-empty"
	/>
</div>
