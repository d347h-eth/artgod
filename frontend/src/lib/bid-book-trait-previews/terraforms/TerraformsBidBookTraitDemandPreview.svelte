<script lang="ts">
	import type { BidBookTraitDemandGroupPreviewProps } from '$lib/bid-book-trait-previews/types';
	import TerraformsBiomeCharacterBand from '$lib/collection-extension-pages/terraforms/TerraformsBiomeCharacterBand.svelte';
	import TerraformsZonePaletteBand from '$lib/collection-extension-pages/terraforms/TerraformsZonePaletteBand.svelte';
	import {
		resolveTerraformsBidBookTraitPreview,
		TERRAFORMS_BID_BOOK_TRAIT_PREVIEW_DOM,
		TERRAFORMS_BID_BOOK_TRAIT_PREVIEW_KINDS
	} from '$lib/bid-book-trait-previews/terraforms/preview-model';

	let { traits }: BidBookTraitDemandGroupPreviewProps = $props();

	let preview = $derived(resolveTerraformsBidBookTraitPreview(traits));
</script>

{#if preview}
	<div
		class={TERRAFORMS_BID_BOOK_TRAIT_PREVIEW_DOM.classes.root}
		data-testid={TERRAFORMS_BID_BOOK_TRAIT_PREVIEW_DOM.testIds.root}
	>
		{#if preview.kind === TERRAFORMS_BID_BOOK_TRAIT_PREVIEW_KINDS.Zone}
			<TerraformsZonePaletteBand
				palette={preview.palette}
				swatchLabels={preview.paletteLabels}
			/>
		{:else}
			<TerraformsBiomeCharacterBand
				characters={preview.characters}
				characterLabels={preview.characterLabels}
				palette={preview.palette}
			/>
		{/if}
	</div>
{/if}

<style>
	.terraforms-bid-book-trait-preview {
		--terraforms-zone-palette-band-swatch-size: 1.4rem;
		--terraforms-biome-character-band-cell-size: 1.56rem;
		--terraforms-biome-character-band-font-size: 1.4rem;
		--terraforms-biome-character-band-padding-block: 0.24rem;
		--terraforms-biome-character-band-padding-inline: 0.32rem;
		width: fit-content;
		margin: 0.36rem auto 0;
	}
</style>
