<script lang="ts">
	import InfoIcon from '$lib/components/InfoIcon.svelte';

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

	const TOOLTIP_GAP_PX = 8;
	const TOOLTIP_VIEWPORT_MARGIN_PX = 12;
	const TOOLTIP_MIN_RIGHT_SPACE_PX = 224;

	let anchorElement = $state<HTMLElement | null>(null);
	let tooltipVisible = $state(false);
	let tooltipStyle = $state('');

	function showTooltip(): void {
		if (!anchorElement || normalizedText.length === 0) {
			return;
		}

		const rect = anchorElement.getBoundingClientRect();
		const top = clamp(
			rect.top + rect.height / 2,
			TOOLTIP_VIEWPORT_MARGIN_PX,
			window.innerHeight - TOOLTIP_VIEWPORT_MARGIN_PX
		);
		const rightSpace =
			window.innerWidth - rect.right - TOOLTIP_GAP_PX - TOOLTIP_VIEWPORT_MARGIN_PX;
		const maxWidth = 'min(18rem, calc(100vw - 1.5rem))';

		if (rightSpace >= TOOLTIP_MIN_RIGHT_SPACE_PX) {
			const left = Math.min(
				rect.right + TOOLTIP_GAP_PX,
				window.innerWidth - TOOLTIP_VIEWPORT_MARGIN_PX
			);
			tooltipStyle = `left: ${left}px; top: ${top}px; max-width: ${maxWidth};`;
		} else {
			const right = Math.max(
				window.innerWidth - rect.left + TOOLTIP_GAP_PX,
				TOOLTIP_VIEWPORT_MARGIN_PX
			);
			tooltipStyle = `right: ${right}px; top: ${top}px; max-width: ${maxWidth};`;
		}

		tooltipVisible = true;
	}

	function hideTooltip(): void {
		tooltipVisible = false;
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			hideTooltip();
		}
	}

	function clamp(value: number, min: number, max: number): number {
		return Math.min(Math.max(value, min), max);
	}
</script>

<svelte:window onresize={hideTooltip} onscroll={hideTooltip} />

{#if normalizedText.length > 0}
	<span
		bind:this={anchorElement}
		class={`info-tooltip info-tooltip-${tone} ${className}`}
		aria-label={normalizedText}
		role="button"
		tabindex="0"
		onmouseenter={showTooltip}
		onmouseleave={hideTooltip}
		onfocus={showTooltip}
		onblur={hideTooltip}
		onkeydown={handleKeydown}
	>
		<span class="info-tooltip-mark" aria-hidden="true">
			<InfoIcon />
		</span>
		{#if tooltipVisible}
			<span class="info-tooltip-popup" style={tooltipStyle} role="tooltip">
				{normalizedText}
			</span>
		{/if}
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
		position: fixed;
		z-index: 400;
		width: max-content;
		min-width: 11rem;
		max-width: min(18rem, calc(100vw - 1.5rem));
		padding: 0.45rem 0.55rem;
		border: 1px solid var(--c-blue);
		background: var(--c-bg);
		color: var(--c-ice);
		font-size: 0.68rem;
		line-height: 1.35;
		letter-spacing: 0;
		text-transform: none;
		white-space: normal;
		transform: translateY(-50%);
		pointer-events: none;
	}

	.info-tooltip-warning .info-tooltip-popup {
		border-color: var(--c-yellow);
	}

	.info-tooltip:hover {
		color: var(--c-yellow);
	}
</style>
