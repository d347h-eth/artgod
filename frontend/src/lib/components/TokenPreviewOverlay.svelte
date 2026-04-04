<script lang="ts">
	import { browser } from '$app/environment';
	import LoadingBladeBar from '$lib/components/LoadingBladeBar.svelte';
	import TokenMediaFrame from '$lib/components/TokenMediaFrame.svelte';
	import {
		getTokenPreviewController,
		tokenPreviewStyle
	} from '$lib/components/token-preview-controller';

	const tokenPreview = getTokenPreviewController();
	const tokenPreviewState = tokenPreview.state;

	let overlayElement = $state<HTMLDivElement | null>(null);

	function onBackdropClick(event: MouseEvent): void {
		if (event.target !== event.currentTarget) return;
		tokenPreview.closeTokenPreview();
	}

	function onBackdropKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape') return;
		event.preventDefault();
		tokenPreview.closeTokenPreview();
	}

	$effect(() => {
		if (!browser || !$tokenPreviewState.open) return;
		queueMicrotask(() => overlayElement?.focus());
	});

	$effect(() => {
		if (!browser || !$tokenPreviewState.open) return;

		const root = document.documentElement;
		const body = document.body;
		const previousRootOverflow = root.style.overflow;
		const previousBodyOverflow = body.style.overflow;

		root.classList.add('token-preview-modal-open');
		root.style.overflow = 'hidden';
		body.style.overflow = 'hidden';

		return () => {
			root.classList.remove('token-preview-modal-open');
			root.style.overflow = previousRootOverflow;
			body.style.overflow = previousBodyOverflow;
		};
	});
</script>

{#if $tokenPreviewState.open}
	<div
		bind:this={overlayElement}
		class="token-preview-overlay"
		style={tokenPreviewStyle($tokenPreviewState)}
		role="dialog"
		aria-modal="true"
		aria-label="Token Preview"
		tabindex="-1"
		onclick={onBackdropClick}
		onkeydown={onBackdropKeydown}
	>
		{#if $tokenPreviewState.availableMediaModes.length > 1}
			<div class="token-preview-media-mode-buttons" aria-label="Preview media mode">
				{#each $tokenPreviewState.availableMediaModes as mode}
					<button
						type="button"
						class:token-preview-media-mode-button-active={mode.key === $tokenPreviewState.selectedMediaMode}
						class="token-preview-media-mode-button"
						disabled={mode.key === $tokenPreviewState.selectedMediaMode}
						onclick={() => void tokenPreview.setTokenPreviewMediaMode(mode.key)}
					>
						{mode.label}
					</button>
				{/each}
			</div>
		{/if}

		{#if $tokenPreviewState.status === 'error'}
			<div class="token-preview-box">
				<div class="token-preview-state token-preview-error">
					{$tokenPreviewState.errorMessage ?? 'Unable to load preview'}
				</div>
			</div>
			{:else if $tokenPreviewState.iframeSource}
				<div class="token-preview-box">
					<TokenMediaFrame
						className="token-preview-frame"
						iframeSource={$tokenPreviewState.iframeSource}
						title={$tokenPreviewState.tokenId ? `token ${$tokenPreviewState.tokenId}` : 'token preview'}
					/>
				</div>
			{/if}

		{#if $tokenPreviewState.status === 'loading'}
			<div class="token-preview-network-spinner">
				<LoadingBladeBar ariaLabel="loading preview" barLength={1} />
			</div>
		{/if}
	</div>
{/if}
