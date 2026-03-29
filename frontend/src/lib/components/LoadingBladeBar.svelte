<script lang="ts">
	import { onMount } from 'svelte';
	import {
		buildLoadingBladeRail,
		DEFAULT_LOADING_BLADE_BAR_LENGTH,
		DEFAULT_LOADING_BLADE_BAR_TICK_MS,
		pickRandomLoadingBlade,
		renderLoadingBladeBarFrame
	} from '$lib/components/loading-blade-bar';

	let {
		ariaLabel = 'loading',
		barLength = DEFAULT_LOADING_BLADE_BAR_LENGTH,
		tickMs = DEFAULT_LOADING_BLADE_BAR_TICK_MS,
		blade = pickRandomLoadingBlade()
	}: {
		ariaLabel?: string;
		barLength?: number;
		tickMs?: number;
		blade?: string;
	} = $props();

	let rail = $state<string[]>(buildLoadingBladeRail(blade, barLength));
	let offset = $state(0);
	let frame = $derived(
		renderLoadingBladeBarFrame({
			rail,
			barLength,
			offset
		})
	);

	$effect(() => {
		rail = buildLoadingBladeRail(blade, barLength);
		offset = 0;
	});

	onMount(() => {
		const intervalId = window.setInterval(() => {
			if (rail.length === 0) return;
			offset = (offset + 1) % rail.length;
		}, Math.max(1, Math.floor(tickMs)));

		return () => {
			window.clearInterval(intervalId);
		};
	});
</script>

<div class="loading-blade-bar" role="img" aria-label={ariaLabel}>
	<span class="loading-blade-bar-frame">{frame}</span>
</div>

<style>
	.loading-blade-bar {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 10ch;
		color: var(--c-cyan);
		text-transform: none;
		letter-spacing: 0;
		line-height: 1;
		font-size: clamp(1rem, 1.8vw, 1.25rem);
	}

	.loading-blade-bar-frame {
		display: inline-block;
		min-width: 10ch;
		white-space: pre;
		font-variant-ligatures: none;
	}
</style>
