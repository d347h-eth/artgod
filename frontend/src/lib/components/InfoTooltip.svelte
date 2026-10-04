<script lang="ts">
	import InfoIcon from '$lib/components/InfoIcon.svelte';
	import WarningIcon from '$lib/components/WarningIcon.svelte';

	let {
		text,
		tone = 'info',
		className = ''
	}: {
		text: string;
		tone?: 'info' | 'warning';
		className?: string;
	} = $props();

	const normalizedText = $derived(text.trim());
	const tooltipId = $props.id();
	const popupId = `${tooltipId}-popup`;
	let dismissed = $state(false);
	let hovered = $state(false);
	let focused = $state(false);
	let activated = $state(false);
	let triggerElement = $state<HTMLSpanElement | null>(null);
	let popupElement = $state<HTMLSpanElement | null>(null);

	$effect(() => {
		const trigger = triggerElement;
		if (!activated || !trigger) return;
		// Pointer focus is released globally; keep activated help readable until dismissal.
		const dismissOutside = (event: Event) => {
			if (event.target instanceof Node && !trigger.contains(event.target)) {
				activated = false;
				dismissed = true;
			}
		};
		const dismissOnEscape = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			event.preventDefault();
			activated = false;
			dismissed = true;
		};
		window.addEventListener('pointerdown', dismissOutside);
		window.addEventListener('focusin', dismissOutside);
		window.addEventListener('keydown', dismissOnEscape);
		return () => {
			window.removeEventListener('pointerdown', dismissOutside);
			window.removeEventListener('focusin', dismissOutside);
			window.removeEventListener('keydown', dismissOnEscape);
		};
	});

	$effect(() => {
		const popup = popupElement;
		if (!popup || dismissed || (!hovered && !focused && !activated)) return;
		// Keep the existing anchored placement, shifting only to avoid viewport clipping.
		const positionPopup = () => {
			popup.style.translate = '';
			if (!popup.getClientRects().length) return;
			const rect = popup.getBoundingClientRect();
			const viewport = window.visualViewport;
			const padding = 8;
			const left = (viewport?.offsetLeft ?? 0) + padding;
			const top = (viewport?.offsetTop ?? 0) + padding;
			const right = left + (viewport?.width ?? document.documentElement.clientWidth) - padding * 2;
			const bottom = top + (viewport?.height ?? document.documentElement.clientHeight) - padding * 2;
			const x = Math.max(left, Math.min(rect.left, right - rect.width)) - rect.left;
			const y = Math.max(top, Math.min(rect.top, bottom - rect.height)) - rect.top;
			popup.style.translate = `${x}px ${y}px`;
		};
		const frame = requestAnimationFrame(positionPopup);
		const observer = new ResizeObserver(positionPopup);
		observer.observe(popup);
		window.addEventListener('resize', positionPopup);
		window.addEventListener('scroll', positionPopup, true);
		window.visualViewport?.addEventListener('resize', positionPopup);
		window.visualViewport?.addEventListener('scroll', positionPopup);
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			window.removeEventListener('resize', positionPopup);
			window.removeEventListener('scroll', positionPopup, true);
			window.visualViewport?.removeEventListener('resize', positionPopup);
			window.visualViewport?.removeEventListener('scroll', positionPopup);
		};
	});

	function showFromActivation(event: MouseEvent): void {
		event.preventDefault();
		event.stopPropagation();
		dismissed = false;
		activated = true;
		if (event.currentTarget instanceof HTMLElement) {
			event.currentTarget.focus();
		}
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			dismissed = true;
			activated = false;
			if (event.currentTarget instanceof HTMLElement) {
				event.currentTarget.blur();
			}
			return;
		}
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();
		event.stopPropagation();
		dismissed = false;
	}
</script>

{#if normalizedText.length > 0}
	<span
		bind:this={triggerElement}
		class={`info-tooltip info-tooltip-${tone} ${className}`}
		class:info-tooltip-dismissed={dismissed}
		class:info-tooltip-activated={activated}
		role="button"
		aria-label={tone === 'warning' ? 'Warning details' : 'Help'}
		aria-describedby={popupId}
		tabindex="0"
		onmouseenter={() => {
			hovered = true;
			dismissed = false;
		}}
		onmouseleave={() => (hovered = false)}
		onfocus={() => {
			focused = true;
			dismissed = false;
		}}
		onblur={() => (focused = false)}
		onclick={showFromActivation}
		onkeydown={handleKeydown}
	>
		<span class="info-tooltip-mark" aria-hidden="true">
			{#if tone === 'warning'}
				<WarningIcon />
			{:else}
				<InfoIcon />
			{/if}
		</span>
		<span bind:this={popupElement} id={popupId} class="info-tooltip-popup" role="tooltip">{normalizedText}</span>
	</span>
{/if}

<style>
	.info-tooltip {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 1rem;
		height: 1rem;
		padding: 0;
		border: 0;
		background: transparent;
		font: inherit;
		cursor: help;
		outline: none;
	}

	.info-tooltip-info {
		color: var(--c-cyan);
	}

	.info-tooltip-warning {
		color: var(--c-yellow);
	}

	.info-tooltip-mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1rem;
		height: 1rem;
	}

	.info-tooltip-popup {
		position: absolute;
		z-index: 60;
		left: calc(100% + 0.45rem);
		top: 50%;
		display: none;
		width: max-content;
		min-width: 11rem;
		max-width: min(22rem, 60vw);
		padding: 0.45rem 0.55rem;
		border: 1px solid var(--c-blue);
		background: var(--c-bg);
		color: var(--c-ice);
		font-size: 0.68rem;
		line-height: 1.35;
		letter-spacing: 0;
		text-transform: none;
		text-align: left;
		white-space: normal;
		transform: translateY(-50%);
		pointer-events: none;
	}

	.info-tooltip-warning .info-tooltip-popup {
		border-color: var(--c-yellow);
	}

	.info-tooltip:hover,
	.info-tooltip:focus-visible,
	.info-tooltip-activated {
		color: var(--c-yellow);
	}

	.info-tooltip:not(.info-tooltip-dismissed):hover .info-tooltip-popup,
	.info-tooltip:not(.info-tooltip-dismissed):focus-visible .info-tooltip-popup,
	.info-tooltip:not(.info-tooltip-dismissed).info-tooltip-activated .info-tooltip-popup {
		display: block;
	}
</style>
