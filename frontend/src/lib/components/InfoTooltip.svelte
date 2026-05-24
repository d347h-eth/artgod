<script lang="ts">
	import InfoIcon from '$lib/components/InfoIcon.svelte';

	let {
		text,
		className = ''
	}: {
		text: string;
		className?: string;
	} = $props();

	const normalizedText = $derived(text.trim());
</script>

{#if normalizedText.length > 0}
	<span class={`info-tooltip ${className}`} aria-label={normalizedText}>
		<span class="info-tooltip-mark" aria-hidden="true">
			<InfoIcon />
		</span>
		<span class="info-tooltip-popup" role="tooltip">{normalizedText}</span>
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
		color: var(--c-cyan);
		cursor: help;
		outline: none;
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
		white-space: normal;
		transform: translateY(-50%);
		pointer-events: none;
	}

	.info-tooltip:hover {
		color: var(--c-yellow);
	}

	.info-tooltip:hover .info-tooltip-popup {
		display: block;
	}
</style>
