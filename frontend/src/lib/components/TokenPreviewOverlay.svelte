<script lang="ts">
	import { browser } from '$app/environment';
	import LoadingBladeBar from '$lib/components/LoadingBladeBar.svelte';
	import TokenMediaFrame from '$lib/components/TokenMediaFrame.svelte';
	import { resolvePreviewBackdropGesture } from '$lib/preview-backdrop-gesture';
	import {
		getTokenPreviewController,
		tokenPreviewStyle
	} from '$lib/components/token-preview-controller';

	const tokenPreview = getTokenPreviewController();
	const tokenPreviewState = tokenPreview.state;

	let overlayElement = $state<HTMLDivElement | null>(null);
	let suppressBackdropClick = $state(false);
	let touchBackdropGesture = $state<{
		pointerId: number;
		startX: number;
		startY: number;
		startMs: number;
	} | null>(null);
	let hoveredPreviewControl = $state<string | null>(null);
	let wasOpen = $state(false);

	function onBackdropClick(event: MouseEvent): void {
		if (event.target !== event.currentTarget) return;
		if (suppressBackdropClick) {
			suppressBackdropClick = false;
			return;
		}
		tokenPreview.closeTokenPreview();
	}

	function onBackdropKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape') return;
		event.preventDefault();
		tokenPreview.closeTokenPreview();
	}

	function onBackdropPointerdown(event: PointerEvent): void {
		if (event.target !== event.currentTarget) return;
		if (event.pointerType !== 'touch' || !event.isPrimary) return;

		touchBackdropGesture = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			startMs: event.timeStamp
		};

		try {
			(event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId);
		} catch {
			// Ignore pointer capture failures and continue with best-effort gesture handling.
		}
	}

	function onBackdropPointerup(event: PointerEvent): void {
		if (!touchBackdropGesture) return;
		if (event.pointerId !== touchBackdropGesture.pointerId) return;

		const gesture = touchBackdropGesture;
		touchBackdropGesture = null;

		try {
			(event.currentTarget as HTMLDivElement).releasePointerCapture(event.pointerId);
		} catch {
			// Ignore pointer capture release failures.
		}

		const action = resolvePreviewBackdropGesture({
			dx: event.clientX - gesture.startX,
			dy: event.clientY - gesture.startY,
			durationMs: event.timeStamp - gesture.startMs
		});

		if (action === 'tap') {
			return;
		}

		suppressBackdropClick = true;

		if (action === 'previous' && $tokenPreviewState.canNavigatePrevious) {
			void tokenPreview.navigatePreviousTokenPreview();
			return;
		}

		if (action === 'next' && $tokenPreviewState.canNavigateNext) {
			void tokenPreview.navigateNextTokenPreview();
		}
	}

	function onBackdropPointercancel(event: PointerEvent): void {
		if (!touchBackdropGesture) return;
		if (event.pointerId !== touchBackdropGesture.pointerId) return;
		touchBackdropGesture = null;

		try {
			(event.currentTarget as HTMLDivElement).releasePointerCapture(event.pointerId);
		} catch {
			// Ignore pointer capture release failures.
		}
	}

	function blurPreviewControl(event: MouseEvent): void {
		if (!(event.currentTarget instanceof HTMLButtonElement)) return;
		event.currentTarget.blur();
	}

	function shouldSuppressPreviewHoverForEnvironment(): boolean {
		if (!browser) return false;
		return (
			window.matchMedia('(hover: none)').matches ||
			window.matchMedia('(pointer: coarse)').matches ||
			window.matchMedia('(any-hover: none)').matches ||
			window.matchMedia('(any-pointer: coarse)').matches ||
			navigator.maxTouchPoints > 0 ||
			'ontouchstart' in window
		);
	}

	function onPreviewControlPointerenter(controlId: string, event: PointerEvent): void {
		if (event.pointerType !== 'mouse' || shouldSuppressPreviewHoverForEnvironment()) return;
		hoveredPreviewControl = controlId;
	}

	function onPreviewControlPointerleave(controlId: string): void {
		if (hoveredPreviewControl !== controlId) return;
		hoveredPreviewControl = null;
	}

	$effect(() => {
		if (!browser) return;
		const isOpen = $tokenPreviewState.open;
		if (isOpen && !wasOpen) {
			queueMicrotask(() => overlayElement?.focus());
		}
		if (!isOpen) {
			hoveredPreviewControl = null;
		}
		wasOpen = isOpen;
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
		onpointerdown={onBackdropPointerdown}
		onpointerup={onBackdropPointerup}
		onpointercancel={onBackdropPointercancel}
	>
		{#if $tokenPreviewState.canNavigatePrevious || $tokenPreviewState.canNavigateNext || $tokenPreviewState.availableMediaModes.length > 1}
			<div class="token-preview-controls">
				{#if $tokenPreviewState.canNavigatePrevious || $tokenPreviewState.canNavigateNext}
					<div class="token-preview-navigation-buttons" aria-label="Preview navigation">
						<button
							type="button"
							class="token-preview-media-mode-button token-preview-navigation-button"
							disabled={!$tokenPreviewState.canNavigatePrevious}
							aria-label="Previous token preview"
							onclick={(event) => {
								blurPreviewControl(event);
								void tokenPreview.navigatePreviousTokenPreview();
							}}
						>
							←
						</button>
						<button
							type="button"
							class="token-preview-media-mode-button token-preview-navigation-button"
							disabled={!$tokenPreviewState.canNavigateNext}
							aria-label="Next token preview"
							onclick={(event) => {
								blurPreviewControl(event);
								void tokenPreview.navigateNextTokenPreview();
							}}
						>
							→
						</button>
					</div>
				{/if}

				{#if $tokenPreviewState.availableMediaModes.length > 1}
					<div class="token-preview-media-mode-buttons" aria-label="Preview media mode">
						{#each $tokenPreviewState.availableMediaModes as mode}
							<button
								type="button"
								class:token-preview-media-mode-button-active={mode.key === $tokenPreviewState.selectedMediaMode}
								class:token-preview-media-mode-button-hovered={hoveredPreviewControl === `mode:${mode.key}`}
								class="token-preview-media-mode-button"
								disabled={mode.key === $tokenPreviewState.selectedMediaMode}
								onpointerenter={(event) =>
									onPreviewControlPointerenter(`mode:${mode.key}`, event)}
								onpointerleave={() => onPreviewControlPointerleave(`mode:${mode.key}`)}
								onclick={(event) => {
									blurPreviewControl(event);
									void tokenPreview.setTokenPreviewMediaMode(mode.key);
								}}
							>
								{mode.label}
							</button>
						{/each}
					</div>
				{/if}
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
