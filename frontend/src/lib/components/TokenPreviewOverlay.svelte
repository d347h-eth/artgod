<script lang="ts">
	import { browser } from '$app/environment';
	import LoadingBladeBar from '$lib/components/LoadingBladeBar.svelte';
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
		{#if tokenPreview.tokenPreviewMediaModeLabel($tokenPreviewState)}
			<button
				type="button"
				class="token-preview-media-mode-button"
				onclick={() => void tokenPreview.cycleTokenPreviewMediaMode()}
			>
				{tokenPreview.tokenPreviewMediaModeLabel($tokenPreviewState)}
			</button>
		{/if}

		<div class="token-preview-box">
			{#if $tokenPreviewState.status === 'ready' && $tokenPreviewState.iframeSource}
				<iframe
					class="token-preview-frame"
					src={$tokenPreviewState.iframeSource.kind === 'src'
						? $tokenPreviewState.iframeSource.value
						: undefined}
					srcdoc={$tokenPreviewState.iframeSource.kind === 'srcdoc'
						? $tokenPreviewState.iframeSource.value
						: undefined}
					title={$tokenPreviewState.tokenId ? `token ${$tokenPreviewState.tokenId}` : 'token preview'}
					sandbox="allow-scripts"
					referrerpolicy="no-referrer"
				></iframe>
			{:else if $tokenPreviewState.status === 'error'}
				<div class="token-preview-state token-preview-error">
					{$tokenPreviewState.errorMessage ?? 'Unable to load preview'}
				</div>
			{:else}
				<div class="token-preview-state token-preview-loading">
					<LoadingBladeBar ariaLabel="loading preview" />
				</div>
			{/if}
		</div>
	</div>
{/if}
