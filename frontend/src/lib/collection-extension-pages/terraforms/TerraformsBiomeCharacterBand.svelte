<script lang="ts">
	import {
		resolveTerraformsBiomePreviewBackgroundColor,
		resolveTerraformsBiomePreviewCharacterColor
	} from '$lib/collection-extension-pages/terraforms/biomes';
	import {
		TERRAFORMS_BIOME_CHARACTER_BAND_DOM,
		TERRAFORMS_TRAIT_PREVIEW_CLASS_NAME_SEPARATOR
	} from '$lib/collection-extension-pages/terraforms/trait-previews';

	type TerraformsBiomeCharacterBandProps = {
		characters: readonly string[];
		characterLabels: readonly string[];
		palette?: readonly string[] | null;
	};

	let { characters, characterLabels, palette = null }: TerraformsBiomeCharacterBandProps = $props();

	let previewBackgroundColor = $derived(resolveTerraformsBiomePreviewBackgroundColor(palette));

	function characterSetClass(): string {
		const classNames: string[] = [TERRAFORMS_BIOME_CHARACTER_BAND_DOM.classes.root];
		if (palette !== null) {
			classNames.push(TERRAFORMS_BIOME_CHARACTER_BAND_DOM.classes.rootWithPalette);
		}
		return classNames.join(TERRAFORMS_TRAIT_PREVIEW_CLASS_NAME_SEPARATOR);
	}

	function characterLabel(index: number, character: string): string {
		return characterLabels[index] ?? character;
	}
</script>

<div class={characterSetClass()} style:background-color={previewBackgroundColor}>
	{#each characters as character, characterIndex}
		<span
			class={TERRAFORMS_BIOME_CHARACTER_BAND_DOM.classes.character}
			data-testid={TERRAFORMS_BIOME_CHARACTER_BAND_DOM.testIds.character}
			style:color={resolveTerraformsBiomePreviewCharacterColor(palette, characterIndex)}
			title={characterLabel(characterIndex, character)}
		>
			{character}
		</span>
	{/each}
</div>

<style>
	.terraforms-biome-character-band {
		display: grid;
		grid-template-columns: repeat(9, var(--terraforms-biome-character-band-cell-size, 20px));
		grid-auto-rows: var(--terraforms-biome-character-band-cell-size, 20px);
		align-items: center;
		width: fit-content;
		padding: var(--terraforms-biome-character-band-padding-block, 8px)
			var(--terraforms-biome-character-band-padding-inline, 10px);
	}

	.terraforms-biome-character-band-character {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: var(--terraforms-biome-character-band-cell-size, 20px);
		height: var(--terraforms-biome-character-band-cell-size, 20px);
		color: var(--c-ice);
		font-family: var(--font-mathcastles-remix);
		font-size: var(--terraforms-biome-character-band-font-size, 18px);
		line-height: 1;
	}
</style>
