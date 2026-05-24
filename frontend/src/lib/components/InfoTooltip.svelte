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

	let popoverElement = $state<HTMLElement | null>(null);

	function showTooltip(): void {
		if (!popoverElement || normalizedText.length === 0 || isPopoverOpen(popoverElement)) {
			return;
		}
		popoverElement.showPopover();
	}

	function hideTooltip(): void {
		if (!popoverElement || !isPopoverOpen(popoverElement)) {
			return;
		}
		popoverElement.hidePopover();
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			hideTooltip();
		}
	}

	function isPopoverOpen(element: HTMLElement): boolean {
		return element.matches(':popover-open');
	}
</script>

{#if normalizedText.length > 0}
	<button
		type="button"
		class={`info-tooltip info-tooltip-${tone} ${className}`}
		aria-label={normalizedText}
		onmouseenter={showTooltip}
		onmouseleave={hideTooltip}
		onfocus={showTooltip}
		onblur={hideTooltip}
		onkeydown={handleKeydown}
	>
		<span class="info-tooltip-mark" aria-hidden="true">
			<InfoIcon />
		</span>
	</button>
	<span
		bind:this={popoverElement}
		class={`info-tooltip-popup info-tooltip-popup-${tone}`}
		popover="manual"
		role="tooltip"
	>
		{normalizedText}
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

	.info-tooltip-popup-warning {
		border-color: var(--c-yellow);
	}

	.info-tooltip-popup::backdrop {
		display: none;
	}

	.info-tooltip:hover {
		color: var(--c-yellow);
	}
</style>
