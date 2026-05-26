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
	displayCharacters: readonly string[];
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

// Font family registered globally for rendered Terraforms Biome glyphs.
export const TERRAFORMS_BIOME_FONT_FAMILY_NAME = 'Mathcastles Remix';

type TerraformsBiomeDisplayCharacterOverrides = Readonly<Record<number, string>>;

// Mathcastles Remix display glyphs replace contract placeholders in the Biome table only.
const TERRAFORMS_BIOME_DISPLAY_CHARACTER_OVERRIDES: Readonly<
	Record<number, TerraformsBiomeDisplayCharacterOverrides>
> = {
	22: { 1: '🏔', 6: '🏔' },
	23: { 0: '🌧', 1: '🌧', 6: '🏔', 7: '🏔', 8: '🏔' },
	24: { 0: '🏔', 7: '🏔', 8: '🏔' },
	25: { 0: '🖳', 8: '🕱' },
	26: { 0: '🗠', 1: '🗠', 6: '🗠' },
	27: { 0: '🗠', 1: '🗠', 3: '🖳', 5: '🗠', 6: '🗠' },
	28: { 0: '🗡', 2: '🗡', 4: '🗡', 5: '🗡', 8: '🗡' },
	29: { 0: '🗡', 2: '🗡', 4: '🗡' },
	30: { 3: '🗠' },
	31: { 2: '🗡', 3: '🗠', 4: '🗡' },
	32: { 0: '🖳', 8: '𓆏' },
	33: { 0: '🖳', 8: '🖳' },
	34: { 0: '🏔', 8: '🏔' },
	35: { 0: '🏔', 8: '🏔' },
	36: { 0: '🏔', 7: '🏔', 8: '🏔' },
	37: { 0: '🖫', 2: '🖫', 6: '🖫', 8: '🖫' },
	41: { 2: '🕱', 3: '🕱', 4: '🕱', 5: '🕈' },
	43: { 8: '🏠' },
	44: { 0: '🏠' },
	48: { 8: '🏔' },
	49: { 0: '🏔', 8: '🏔' },
	50: { 0: '🕈', 1: '🞗', 2: '🞗', 3: '🞗' },
	53: { 0: '🕱', 1: '🕱', 2: '🀰', 3: '🀰', 4: '🀰', 5: '🀰' },
	54: { 0: '🕱', 1: '🕱', 2: 'GM', 3: 'GM', 6: 'GM', 8: '🖳' },
	55: { 0: '𓁹', 7: '🗁', 8: '🗁' },
	62: { 0: '🗡', 1: '🞗', 2: '🞗', 3: '🞗', 4: '🞗', 5: '𓁹', 6: '𓁹', 7: '𓁹', 8: '🗝' },
	64: { 8: '🗝' },
	66: { 0: '🖳', 1: '🖳', 2: '🖳', 3: '🞗', 4: '🞗', 5: '🗊', 6: '🗊', 7: '🗊', 8: '🗊' },
	68: { 4: '🗠', 5: '🗠' },
	69: { 0: '🖳', 7: '🖳', 8: '🖳' },
	70: { 0: '𓆏', 7: '🖳', 8: '🖳' },
	71: { 0: '🖳', 8: '🖳' },
	72: { 0: '🖳', 8: '🖳' },
	73: { 0: '𝕺', 1: '𝕺', 2: '𝕺', 3: '🞗', 4: '🞗', 5: '🞗', 6: '𝖃', 7: '𝖃', 8: '𝖃' },
	74: { 3: '🟣', 4: '🟣', 5: '🟣', 6: '🟣', 7: '🟣' },
	76: { 0: '𝕺', 1: '🞗', 2: '🞗', 3: '🞗', 6: '𝖃', 7: '𝖃', 8: '𝖃' },
	79: { 3: '🞗', 4: '🞗', 5: '🞗', 6: '🞗' },
	83: { 0: '🌢' },
	86: { 0: '🖧', 1: '🞗', 2: '🞗', 3: '🞗', 4: '🞗', 5: '🞗', 6: '🖧', 7: '🗈', 8: '🗈' },
	91: { 0: '🟣' }
} as const;

// Builds the all-level Biome catalog from static contract data.
export function buildTerraformsBiomeRows(
	biomes: readonly TerraformsBiome[] = TERRAFORMS_BIOMES
): TerraformsBiomeRow[] {
	return biomes.map((biome) => ({
		key: [TERRAFORMS_BIOME_ROW_KEY_PREFIX, biome.index].join(TERRAFORMS_BIOME_ROW_KEY_SEPARATOR),
		biomeIndex: biome.index,
		characters: biome.characters,
		displayCharacters: resolveTerraformsBiomeDisplayCharacters(biome)
	}));
}

// Resolves the glyphs expected by the embedded Mathcastles Remix font.
export function resolveTerraformsBiomeDisplayCharacters(biome: TerraformsBiome): readonly string[] {
	const overrides = TERRAFORMS_BIOME_DISPLAY_CHARACTER_OVERRIDES[biome.index];
	if (overrides === undefined) {
		return biome.characters;
	}

	return biome.characters.map((character, index) => overrides[index] ?? character);
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
	return [TERRAFORMS_BIOME_TOKEN_LABEL_PREFIX, String(biomeIndex)].join(
		TERRAFORMS_BIOME_TOKEN_LABEL_SEPARATOR
	);
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
