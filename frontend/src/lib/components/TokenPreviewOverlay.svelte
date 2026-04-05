<script lang="ts">
	import { browser } from '$app/environment';
	import LoadingBladeBar from '$lib/components/LoadingBladeBar.svelte';
	import TokenMediaFrame from '$lib/components/TokenMediaFrame.svelte';
	import { resolvePreviewBackdropGesture } from '$lib/preview-backdrop-gesture';
	import { TOKEN_PREVIEW_SWIPE_HINT_DISMISSED_STORAGE_KEY } from '$lib/token-preview-storage';
	import {
		getTokenPreviewController,
		tokenPreviewStyle
	} from '$lib/components/token-preview-controller';

	const tokenPreview = getTokenPreviewController();
	const tokenPreviewState = tokenPreview.state;

	let overlayElement = $state<HTMLDivElement | null>(null);
	let previewBoxElement = $state<HTMLDivElement | null>(null);
	let swipeHintElement = $state<HTMLButtonElement | null>(null);
	let suppressBackdropClick = $state(false);
	let touchBackdropGesture = $state<{
		identifier: number;
		source: 'backdrop' | 'hint';
		startX: number;
		startY: number;
		lastX: number;
		lastY: number;
		startMs: number;
	} | null>(null);
	let hoveredPreviewControl = $state<string | null>(null);
	let isTouchLikePreviewEnvironment = $state(false);
	let swipeHintDismissed = $state(false);
	let touchModeButtonsFit = $state(false);
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

	function onBackdropTouchstart(event: TouchEvent): void {
		if (event.target !== event.currentTarget) return;
		beginTouchGesture(event, 'backdrop');
	}

	function onBackdropTouchend(event: TouchEvent): void {
		finishTouchGesture(event);
	}

	function onBackdropTouchcancel(event: TouchEvent): void {
		cancelTouchGesture(event);
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

	function beginTouchGesture(event: TouchEvent, source: 'backdrop' | 'hint'): void {
		const touch = event.changedTouches.item(0);
		if (!touch) return;

		touchBackdropGesture = {
			identifier: touch.identifier,
			source,
			startX: touch.clientX,
			startY: touch.clientY,
			lastX: touch.clientX,
			lastY: touch.clientY,
			startMs: event.timeStamp
		};
		event.preventDefault();
	}

	function onTouchGestureMove(event: TouchEvent): void {
		if (!touchBackdropGesture) return;
		const touch = findChangedTouch(event.changedTouches, touchBackdropGesture.identifier);
		if (!touch) return;
		touchBackdropGesture = {
			...touchBackdropGesture,
			lastX: touch.clientX,
			lastY: touch.clientY
		};
		event.preventDefault();
	}

	function finishTouchGesture(event: TouchEvent): void {
		if (!touchBackdropGesture) return;
		const touch = findChangedTouch(event.changedTouches, touchBackdropGesture.identifier);
		if (!touch) return;

		const gesture = touchBackdropGesture;
		touchBackdropGesture = null;

		const endX = touch.clientX || gesture.lastX;
		const endY = touch.clientY || gesture.lastY;
		const action = resolvePreviewBackdropGesture({
			dx: endX - gesture.startX,
			dy: endY - gesture.startY,
			durationMs: event.timeStamp - gesture.startMs
		});

		if (action === 'tap') {
			event.preventDefault();
			if (gesture.source === 'hint') {
				dismissSwipeHint();
				return;
			}
			suppressBackdropClick = true;
			tokenPreview.closeTokenPreview();
			return;
		}

		suppressBackdropClick = true;
		dismissSwipeHint();
		event.preventDefault();

		if (action === 'previous' && $tokenPreviewState.canNavigatePrevious) {
			void tokenPreview.navigatePreviousTokenPreview();
			return;
		}

		if (action === 'next' && $tokenPreviewState.canNavigateNext) {
			void tokenPreview.navigateNextTokenPreview();
		}
	}

	function cancelTouchGesture(event: TouchEvent): void {
		if (!touchBackdropGesture) return;
		const touch = findChangedTouch(event.changedTouches, touchBackdropGesture.identifier);
		if (!touch) return;
		touchBackdropGesture = null;
		event.preventDefault();
	}

	function findChangedTouch(touches: TouchList, identifier: number): Touch | null {
		for (let index = 0; index < touches.length; index += 1) {
			const touch = touches.item(index);
			if (touch && touch.identifier === identifier) {
				return touch;
			}
		}
		return null;
	}

	function syncTouchLikePreviewEnvironment(): void {
		isTouchLikePreviewEnvironment = shouldSuppressPreviewHoverForEnvironment();
	}

	function readSwipeHintDismissed(): boolean {
		if (!browser) return false;
		try {
			return window.localStorage.getItem(TOKEN_PREVIEW_SWIPE_HINT_DISMISSED_STORAGE_KEY) === '1';
		} catch {
			return false;
		}
	}

	function dismissSwipeHint(): void {
		if (swipeHintDismissed) return;
		swipeHintDismissed = true;
		if (!browser) return;
		try {
			window.localStorage.setItem(TOKEN_PREVIEW_SWIPE_HINT_DISMISSED_STORAGE_KEY, '1');
		} catch {
			// Ignore storage failures and keep the in-memory dismissal state.
		}
	}

	function readOverlayCssPx(customPropertyName: string, fallback: number): number {
		if (!overlayElement) return fallback;
		const raw = getComputedStyle(overlayElement).getPropertyValue(customPropertyName).trim();
		const parsed = Number.parseFloat(raw);
		return Number.isFinite(parsed) ? parsed : fallback;
	}

	function updateTouchModeButtonsFit(): void {
		if (
			!browser ||
			!overlayElement ||
			!previewBoxElement ||
			!$tokenPreviewState.open ||
			!isTouchLikePreviewEnvironment ||
			shouldRenderTouchSwipeHint() ||
			$tokenPreviewState.availableMediaModes.length <= 1
		) {
			touchModeButtonsFit = false;
			return;
		}

		const overlayRect = overlayElement.getBoundingClientRect();
		const boxRect = previewBoxElement.getBoundingClientRect();
		const bottomMargin = Math.max(0, overlayRect.bottom - boxRect.bottom);
		const controlHeight = readOverlayCssPx('--token-preview-control-height', 28);
		const bottomBuffer = readOverlayCssPx('--token-preview-mobile-min-backdrop-buffer', 28);

		touchModeButtonsFit = bottomMargin >= controlHeight + bottomBuffer;
	}

	function shouldRenderTouchSwipeHint(): boolean {
		return (
			isTouchLikePreviewEnvironment &&
			!swipeHintDismissed &&
			($tokenPreviewState.canNavigatePrevious || $tokenPreviewState.canNavigateNext)
		);
	}

	function shouldRenderTouchModeButtons(): boolean {
		return (
			isTouchLikePreviewEnvironment &&
			!shouldRenderTouchSwipeHint() &&
			$tokenPreviewState.availableMediaModes.length > 1 &&
			touchModeButtonsFit
		);
	}

	function shouldRenderDesktopControls(): boolean {
		return (
			!isTouchLikePreviewEnvironment &&
			($tokenPreviewState.canNavigatePrevious ||
				$tokenPreviewState.canNavigateNext ||
				$tokenPreviewState.availableMediaModes.length > 1)
		);
	}

	$effect(() => {
		if (!browser) return;
		syncTouchLikePreviewEnvironment();
		swipeHintDismissed = readSwipeHintDismissed();
		const mediaQueries = [
			window.matchMedia('(hover: none)'),
			window.matchMedia('(pointer: coarse)'),
			window.matchMedia('(any-hover: none)'),
			window.matchMedia('(any-pointer: coarse)')
		];
		const handleEnvironmentChange = () => {
			syncTouchLikePreviewEnvironment();
			updateTouchModeButtonsFit();
		};
		for (const query of mediaQueries) {
			query.addEventListener('change', handleEnvironmentChange);
		}
		window.addEventListener('resize', handleEnvironmentChange);
		window.visualViewport?.addEventListener('resize', handleEnvironmentChange);
		return () => {
			for (const query of mediaQueries) {
				query.removeEventListener('change', handleEnvironmentChange);
			}
			window.removeEventListener('resize', handleEnvironmentChange);
			window.visualViewport?.removeEventListener('resize', handleEnvironmentChange);
		};
	});

	$effect(() => {
		if (!browser || !$tokenPreviewState.open) {
			touchModeButtonsFit = false;
			return;
		}

		const update = () => {
			updateTouchModeButtonsFit();
		};
		const frameId = requestAnimationFrame(update);
		const observer = new ResizeObserver(update);
		if (overlayElement) observer.observe(overlayElement);
		if (previewBoxElement) observer.observe(previewBoxElement);

		return () => {
			cancelAnimationFrame(frameId);
			observer.disconnect();
		};
	});

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

	$effect(() => {
		if (!browser || !$tokenPreviewState.open || !isTouchLikePreviewEnvironment || !overlayElement) {
			return;
		}

		const overlay = overlayElement;
		overlay.addEventListener('touchstart', onBackdropTouchstart, { passive: false });
		overlay.addEventListener('touchmove', onTouchGestureMove, { passive: false });
		overlay.addEventListener('touchend', onBackdropTouchend, { passive: false });
		overlay.addEventListener('touchcancel', onBackdropTouchcancel, { passive: false });

		const hint = swipeHintElement;
		if (hint) {
			const onHintTouchstart = (event: TouchEvent) => beginTouchGesture(event, 'hint');
			hint.addEventListener('touchstart', onHintTouchstart, { passive: false });
			hint.addEventListener('touchmove', onTouchGestureMove, { passive: false });
			hint.addEventListener('touchend', finishTouchGesture, { passive: false });
			hint.addEventListener('touchcancel', cancelTouchGesture, { passive: false });

			return () => {
				overlay.removeEventListener('touchstart', onBackdropTouchstart);
				overlay.removeEventListener('touchmove', onTouchGestureMove);
				overlay.removeEventListener('touchend', onBackdropTouchend);
				overlay.removeEventListener('touchcancel', onBackdropTouchcancel);
				hint.removeEventListener('touchstart', onHintTouchstart);
				hint.removeEventListener('touchmove', onTouchGestureMove);
				hint.removeEventListener('touchend', finishTouchGesture);
				hint.removeEventListener('touchcancel', cancelTouchGesture);
			};
		}

		return () => {
			overlay.removeEventListener('touchstart', onBackdropTouchstart);
			overlay.removeEventListener('touchmove', onTouchGestureMove);
			overlay.removeEventListener('touchend', onBackdropTouchend);
			overlay.removeEventListener('touchcancel', onBackdropTouchcancel);
		};
	});
</script>

{#if $tokenPreviewState.open}
	<div
		bind:this={overlayElement}
		class:token-preview-overlay-touch={isTouchLikePreviewEnvironment}
		class="token-preview-overlay"
		style={tokenPreviewStyle($tokenPreviewState)}
		role="dialog"
		aria-modal="true"
		aria-label="Token Preview"
		tabindex="-1"
		onclick={onBackdropClick}
		onkeydown={onBackdropKeydown}
	>
		{#if shouldRenderDesktopControls()}
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

		{#if shouldRenderTouchSwipeHint() || shouldRenderTouchModeButtons()}
			<div class="token-preview-touch-controls">
				{#if shouldRenderTouchSwipeHint()}
					<button
						bind:this={swipeHintElement}
						type="button"
						class="token-preview-media-mode-button token-preview-swipe-hint-button"
						onclick={() => dismissSwipeHint()}
					>
						swipe for navigation
					</button>
				{:else if shouldRenderTouchModeButtons()}
					<div class="token-preview-media-mode-buttons" aria-label="Preview media mode">
						{#each $tokenPreviewState.availableMediaModes as mode}
							<button
								type="button"
								class:token-preview-media-mode-button-active={mode.key === $tokenPreviewState.selectedMediaMode}
								class="token-preview-media-mode-button"
								disabled={mode.key === $tokenPreviewState.selectedMediaMode}
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
			<div bind:this={previewBoxElement} class="token-preview-box">
				<div class="token-preview-state token-preview-error">
					{$tokenPreviewState.errorMessage ?? 'Unable to load preview'}
				</div>
			</div>
			{:else if $tokenPreviewState.iframeSource}
				<div bind:this={previewBoxElement} class="token-preview-box">
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
