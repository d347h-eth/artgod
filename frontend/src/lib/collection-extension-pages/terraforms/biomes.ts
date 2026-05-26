import {
	TERRAFORMS_BIOME_ATTRIBUTE_KEY,
	TERRAFORMS_BIOMES,
	type TerraformsBiome
} from '@artgod/shared/extensions/terraforms';
import { buildTerraformsHypercastleTraitTokenHref } from '$lib/collection-extension-pages/terraforms/hypercastle-token-links';

export type TerraformsBiomeRow = {
	key: string;
	biomeIndex: number;
	characters: readonly string[];
};

// Labels used by the all-level Biome table.
export const TERRAFORMS_BIOME_TABLE_LABELS = {
	Heading: 'biomes',
	Number: 'number',
	CharacterSet: 'character set'
} as const;

// DOM names are exported so browser probes can target extension-owned Biome UI.
export const TERRAFORMS_BIOME_TABLE_DOM = {
	testIds: {
		panel: 'terraforms-hypercastle-biome-detail',
		table: 'terraforms-hypercastle-biome-table',
		character: 'terraforms-hypercastle-biome-character'
	},
	classes: {
		panel: 'terraforms-hypercastle-biome-detail',
		table: 'terraforms-hypercastle-biome-table',
		numberCell: 'terraforms-hypercastle-biome-number-cell',
		characterSet: 'terraforms-hypercastle-biome-character-set',
		character: 'terraforms-hypercastle-biome-character'
	}
} as const;

const TERRAFORMS_BIOME_ROW_KEY_PREFIX = 'biome';
const TERRAFORMS_BIOME_ROW_KEY_SEPARATOR = ':';
const TERRAFORMS_BIOME_TOKEN_LABEL_PREFIX = 'filter tokens by Biome';
const TERRAFORMS_BIOME_TOKEN_LABEL_SEPARATOR = ' ';
const TERRAFORMS_BIOME_CHARACTER_LABEL_PREFIX = 'Biome character';
const TERRAFORMS_BIOME_CHARACTER_LABEL_SEPARATOR = ' ';

// Builds the all-level Biome catalog from static contract data.
export function buildTerraformsBiomeRows(
	biomes: readonly TerraformsBiome[] = TERRAFORMS_BIOMES
): TerraformsBiomeRow[] {
	return biomes.map((biome) => ({
		key: [TERRAFORMS_BIOME_ROW_KEY_PREFIX, biome.index].join(
			TERRAFORMS_BIOME_ROW_KEY_SEPARATOR
		),
		biomeIndex: biome.index,
		characters: biome.characters
	}));
}

// Builds a token-browser href filtered to one Biome number.
export function buildTerraformsBiomeTokenHref(input: {
	basePath: string;
	mediaMode?: string | null;
	biomeIndex: number;
}): string {
	return buildTerraformsHypercastleTraitTokenHref({
		basePath: input.basePath,
		mediaMode: input.mediaMode ?? null,
		traitKey: TERRAFORMS_BIOME_ATTRIBUTE_KEY,
		traitValue: String(input.biomeIndex)
	});
}

// Builds the accessible label for a Biome token filter link.
export function formatTerraformsBiomeTokenLabel(biomeIndex: number): string {
	return [
		TERRAFORMS_BIOME_TOKEN_LABEL_PREFIX,
		String(biomeIndex)
	].join(TERRAFORMS_BIOME_TOKEN_LABEL_SEPARATOR);
}

// Builds the accessible label for one Biome character swatch.
export function formatTerraformsBiomeCharacterLabel(input: {
	biomeIndex: number;
	position: number;
	character: string;
}): string {
	return [
		TERRAFORMS_BIOME_CHARACTER_LABEL_PREFIX,
		String(input.biomeIndex),
		String(input.position),
		input.character
	].join(TERRAFORMS_BIOME_CHARACTER_LABEL_SEPARATOR);
}
