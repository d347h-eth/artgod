import { TERRAFORMS_TRAIT_TABLE_BUTTON_TYPES } from '$lib/collection-extension-pages/terraforms/trait-table';

// Shared separator for composing Terraforms trait-preview class names.
export const TERRAFORMS_TRAIT_PREVIEW_CLASS_NAME_SEPARATOR = ' ';

export const TERRAFORMS_TRAIT_PREVIEW_BUTTON_TYPES = TERRAFORMS_TRAIT_TABLE_BUTTON_TYPES;

// DOM contract for reusable Zone palette preview bands.
export const TERRAFORMS_ZONE_PALETTE_BAND_DOM = {
	testIds: {
		swatch: 'terraforms-zone-palette-band-swatch'
	},
	classes: {
		root: 'terraforms-zone-palette-band',
		swatch: 'terraforms-zone-palette-band-swatch'
	}
} as const;

// DOM contract for reusable Biome character preview bands.
export const TERRAFORMS_BIOME_CHARACTER_BAND_DOM = {
	testIds: {
		character: 'terraforms-biome-character-band-character'
	},
	classes: {
		root: 'terraforms-biome-character-band',
		rootWithPalette: 'terraforms-biome-character-band-with-palette',
		character: 'terraforms-biome-character-band-character'
	}
} as const;
