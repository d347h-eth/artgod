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

	function showFromActivation(event: MouseEvent): void {
		event.preventDefault();
		event.stopPropagation();
		dismissed = false;
		if (event.currentTarget instanceof HTMLElement) {
			event.currentTarget.focus();
		}
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			dismissed = true;
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
		class={`info-tooltip info-tooltip-${tone} ${className}`}
		class:info-tooltip-dismissed={dismissed}
		role="button"
		aria-label={tone === 'warning' ? 'Warning details' : 'Help'}
		aria-describedby={popupId}
		tabindex="0"
		onmouseenter={() => (dismissed = false)}
		onfocus={() => (dismissed = false)}
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
		<span id={popupId} class="info-tooltip-popup" role="tooltip">{normalizedText}</span>
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
	.info-tooltip:focus-visible {
		color: var(--c-yellow);
	}

	.info-tooltip:not(.info-tooltip-dismissed):hover .info-tooltip-popup,
	.info-tooltip:not(.info-tooltip-dismissed):focus-visible .info-tooltip-popup {
		display: block;
	}
</style>
