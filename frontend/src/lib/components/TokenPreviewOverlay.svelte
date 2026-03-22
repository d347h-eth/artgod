<script lang="ts">
	import type {
		TokenPreviewController,
		TokenPreviewState
	} from '$lib/components/token-preview-controller';
	import { tokenPreviewStyle } from '$lib/components/token-preview-controller';

	let {
		state,
		closeTokenPreview,
		tokenPreview
	}: {
		state: TokenPreviewState;
		closeTokenPreview: () => void;
		tokenPreview: TokenPreviewController;
	} = $props();

	function onBackdropClick(event: MouseEvent): void {
		if (event.target !== event.currentTarget) return;
		closeTokenPreview();
	}

	function onBackdropKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape') return;
		event.preventDefault();
		closeTokenPreview();
	}
</script>

{#if state.open}
	<div
		class="token-preview-overlay"
		style={tokenPreviewStyle(state)}
		role="dialog"
		aria-modal="true"
		aria-label="Token Preview"
		tabindex="-1"
		onclick={onBackdropClick}
		onkeydown={onBackdropKeydown}
	>
		{#if tokenPreview.tokenPreviewMediaModeLabel(state)}
			<button
				type="button"
				class="token-preview-media-mode-button"
				onclick={() => void tokenPreview.cycleTokenPreviewMediaMode()}
			>
				{tokenPreview.tokenPreviewMediaModeLabel(state)}
			</button>
		{/if}
		{#if state.mediaKind === 'iframe' && state.mediaUrl}
			<iframe
				class="token-preview-frame"
				src={state.mediaUrl}
				title={state.tokenId ? `token ${state.tokenId}` : 'token preview'}
				sandbox="allow-scripts"
				referrerpolicy="no-referrer"
			></iframe>
		{:else if state.mediaKind === 'image' && state.mediaUrl}
			<img
				class="token-preview-image"
				src={state.mediaUrl}
				alt={state.tokenId ? `token ${state.tokenId}` : 'token preview'}
				loading="eager"
				decoding="async"
				referrerpolicy="no-referrer"
			/>
		{/if}
	</div>
{/if}
