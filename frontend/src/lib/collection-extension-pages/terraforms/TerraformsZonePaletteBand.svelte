<script lang="ts">
	import {
		TERRAFORMS_TRAIT_PREVIEW_BUTTON_TYPES,
		TERRAFORMS_ZONE_PALETTE_BAND_DOM
	} from '$lib/collection-extension-pages/terraforms/trait-previews';

	type TerraformsZonePaletteBandProps = {
		palette: readonly string[];
		swatchLabels: readonly string[];
		selectable?: boolean;
		onSelect?: () => void;
	};

	let {
		palette,
		swatchLabels,
		selectable = false,
		onSelect
	}: TerraformsZonePaletteBandProps = $props();

	function swatchLabel(index: number, color: string): string {
		return swatchLabels[index] ?? color;
	}
</script>

<div class={TERRAFORMS_ZONE_PALETTE_BAND_DOM.classes.root}>
	{#each palette as color, colorIndex}
		{@const label = swatchLabel(colorIndex, color)}
		{#if selectable}
			<button
				type={TERRAFORMS_TRAIT_PREVIEW_BUTTON_TYPES.Button}
				class={TERRAFORMS_ZONE_PALETTE_BAND_DOM.classes.swatch}
				data-testid={TERRAFORMS_ZONE_PALETTE_BAND_DOM.testIds.swatch}
				style:background-color={color}
				title={label}
				aria-label={label}
				onclick={() => onSelect?.()}
			></button>
		{:else}
			<span
				class={TERRAFORMS_ZONE_PALETTE_BAND_DOM.classes.swatch}
				data-testid={TERRAFORMS_ZONE_PALETTE_BAND_DOM.testIds.swatch}
				style:background-color={color}
				title={label}
			></span>
		{/if}
	{/each}
</div>

<style>
	.terraforms-zone-palette-band {
		display: grid;
		grid-template-columns: repeat(10, var(--terraforms-zone-palette-band-swatch-size, 16px));
		grid-auto-rows: var(--terraforms-zone-palette-band-swatch-size, 16px);
		width: fit-content;
		background: var(--c-bg);
	}

	.terraforms-zone-palette-band-swatch {
		display: block;
		width: var(--terraforms-zone-palette-band-swatch-size, 16px);
		height: var(--terraforms-zone-palette-band-swatch-size, 16px);
		min-height: 0;
		border: 0;
		border-radius: 0;
		padding: 0;
		appearance: none;
	}

	button.terraforms-zone-palette-band-swatch {
		cursor: pointer;
	}

	button.terraforms-zone-palette-band-swatch:hover,
	button.terraforms-zone-palette-band-swatch:focus-visible {
		position: relative;
		z-index: 1;
		outline: 1px solid var(--c-ice);
		outline-offset: -1px;
	}
</style>
