import {
	TERRAFORMS_BIOME_ATTRIBUTE_KEY,
	TERRAFORMS_BIOMES,
	type TerraformsBiome
} from '@artgod/shared/extensions/terraforms';
import { buildTerraformsHypercastleTraitTokenHref } from '$lib/collection-extension-pages/terraforms/hypercastle-token-links';
import type { TerraformsTraitCountIndex } from '$lib/collection-extension-pages/terraforms/trait-catalog-counts';
import {
	compareTerraformsTraitTableNullableNumbers,
	compareTerraformsTraitTableNumbers,
	compareTerraformsTraitTableStrings,
	formatTerraformsTraitTableSortLabel,
	resolveTerraformsTraitTableAriaSort,
	resolveTerraformsTraitTableDefaultSortDirection,
	sortTerraformsTraitTableRows,
	TERRAFORMS_TRAIT_TABLE_SORT_DIRECTIONS,
	toggleTerraformsTraitTableSortDirection,
	type TerraformsTraitTableSortDirection
} from '$lib/collection-extension-pages/terraforms/trait-table';

type ValueOf<T> = T[keyof T];

export type TerraformsBiomeRow = {
	key: string;
	biomeIndex: number;
	characters: readonly string[];
	displayCharacters: readonly string[];
	mintedTokenCount: number | null;
};

// Sort columns are the stable contract between the Biome table, tests, and browser probes.
export const TERRAFORMS_BIOME_TABLE_COLUMNS = {
	Number: 'number',
	CharacterSet: 'character_set',
	Minted: 'minted'
} as const;

export type TerraformsBiomeTableColumn = ValueOf<typeof TERRAFORMS_BIOME_TABLE_COLUMNS>;

export type TerraformsBiomeSortDirection = TerraformsTraitTableSortDirection;

// Labels used by the all-level Biome table.
export const TERRAFORMS_BIOME_TABLE_LABELS = {
	Heading: 'biomes',
	ResetColors: 'reset colors',
	[TERRAFORMS_BIOME_TABLE_COLUMNS.Number]: 'number',
	[TERRAFORMS_BIOME_TABLE_COLUMNS.CharacterSet]: 'character set',
	[TERRAFORMS_BIOME_TABLE_COLUMNS.Minted]: 'minted'
} as const;

// Biome tables use the same column order in all-level and selected-level views.
export const TERRAFORMS_BIOME_TABLE_COLUMNS_ORDER = [
	TERRAFORMS_BIOME_TABLE_COLUMNS.Number,
	TERRAFORMS_BIOME_TABLE_COLUMNS.CharacterSet,
	TERRAFORMS_BIOME_TABLE_COLUMNS.Minted
] as const satisfies readonly TerraformsBiomeTableColumn[];

// DOM names are exported so browser probes can target extension-owned Biome UI.
export const TERRAFORMS_BIOME_TABLE_DOM = {
	testIds: {
		panel: 'terraforms-hypercastle-biome-detail',
		table: 'terraforms-hypercastle-biome-table',
		colorResetButton: 'terraforms-hypercastle-biome-color-reset'
	},
	classes: {
		panel: 'terraforms-hypercastle-biome-detail',
		controls: 'terraforms-hypercastle-biome-detail-controls',
		colorResetButton: 'facet-panel-action-button facet-reset-button',
		table: 'terraforms-hypercastle-biome-table',
		numberCell: 'terraforms-hypercastle-biome-number-cell'
	}
} as const;

const TERRAFORMS_BIOME_ROW_KEY_PREFIX = 'biome';
const TERRAFORMS_BIOME_ROW_KEY_SEPARATOR = ':';
const TERRAFORMS_BIOME_TOKEN_LABEL_PREFIX = 'filter tokens by Biome';
const TERRAFORMS_BIOME_TOKEN_LABEL_SEPARATOR = ' ';
const TERRAFORMS_BIOME_CHARACTER_LABEL_PREFIX = 'Biome character';
const TERRAFORMS_BIOME_CHARACTER_LABEL_SEPARATOR = ' ';
const TERRAFORMS_BIOME_EMPTY_STRING = '';
const TERRAFORMS_BIOME_COUNT_FORMAT = new Intl.NumberFormat(undefined, {
	maximumFractionDigits: 0
});
const TERRAFORMS_BIOME_DEFAULT_SORT_COLUMN = TERRAFORMS_BIOME_TABLE_COLUMNS.Number;
const TERRAFORMS_BIOME_DEFAULT_SORT_DIRECTION = TERRAFORMS_TRAIT_TABLE_SORT_DIRECTIONS.Ascending;
const TERRAFORMS_BIOME_ASCENDING_COLUMNS = new Set<TerraformsBiomeTableColumn>([
	TERRAFORMS_BIOME_TABLE_COLUMNS.Number,
	TERRAFORMS_BIOME_TABLE_COLUMNS.CharacterSet
]);
const TERRAFORMS_BIOME_CHARACTER_SEPARATOR = '';
const TERRAFORMS_BIOME_BACKGROUND_COLOR_INDEX = 9;

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
	54: { 0: '🕱', 1: '🕱', 8: '🖳' },
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
		displayCharacters: resolveTerraformsBiomeDisplayCharacters(biome),
		mintedTokenCount: null
	}));
}

// Applies minted trait counts after the backend catalog response arrives.
export function applyTerraformsBiomeTokenCounts(
	rows: readonly TerraformsBiomeRow[],
	counts: TerraformsTraitCountIndex,
	countsLoaded: boolean,
	options: { mintedOnly?: boolean } = {}
): TerraformsBiomeRow[] {
	const countedRows = rows.map((row) => ({
		...row,
		mintedTokenCount: countsLoaded ? (counts[String(row.biomeIndex)] ?? 0) : null
	}));
	if (!options.mintedOnly) {
		return countedRows;
	}
	return countsLoaded
		? countedRows.filter((row) => row.mintedTokenCount !== null && row.mintedTokenCount > 0)
		: [];
}

// Sorts Biome rows by the active user-selected table column.
export function sortTerraformsBiomeRows(
	rows: readonly TerraformsBiomeRow[],
	column: TerraformsBiomeTableColumn,
	direction: TerraformsBiomeSortDirection
): TerraformsBiomeRow[] {
	return sortTerraformsTraitTableRows(rows, column, direction, compareTerraformsBiomeRows);
}

// Chooses the default direction when a new sortable Biome column becomes active.
export function resolveTerraformsBiomeDefaultSortDirection(
	column: TerraformsBiomeTableColumn
): TerraformsBiomeSortDirection {
	return resolveTerraformsTraitTableDefaultSortDirection(
		column,
		TERRAFORMS_BIOME_ASCENDING_COLUMNS
	);
}

// Flips an active Biome sort direction after the user repeats a header click.
export function toggleTerraformsBiomeSortDirection(
	direction: TerraformsBiomeSortDirection
): TerraformsBiomeSortDirection {
	return toggleTerraformsTraitTableSortDirection(direction);
}

// Exposes the initial Biome table state without duplicating literals in the component.
export function defaultTerraformsBiomeSortColumn(): TerraformsBiomeTableColumn {
	return TERRAFORMS_BIOME_DEFAULT_SORT_COLUMN;
}

// Exposes the initial Biome table state without duplicating literals in the component.
export function defaultTerraformsBiomeSortDirection(): TerraformsBiomeSortDirection {
	return TERRAFORMS_BIOME_DEFAULT_SORT_DIRECTION;
}

// Builds the accessible label for sortable Biome table headers.
export function formatTerraformsBiomeSortLabel(column: TerraformsBiomeTableColumn): string {
	return formatTerraformsTraitTableSortLabel(TERRAFORMS_BIOME_TABLE_LABELS[column]);
}

// Resolves aria-sort for the active dynamic Biome table header.
export function resolveTerraformsBiomeAriaSort(
	column: TerraformsBiomeTableColumn,
	activeColumn: TerraformsBiomeTableColumn,
	direction: TerraformsBiomeSortDirection
) {
	return resolveTerraformsTraitTableAriaSort(column, activeColumn, direction);
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

// Formats exact minted token counts once the trait catalog has loaded.
export function formatTerraformsBiomeMintedTokenCount(row: TerraformsBiomeRow): string {
	return row.mintedTokenCount === null
		? TERRAFORMS_BIOME_EMPTY_STRING
		: TERRAFORMS_BIOME_COUNT_FORMAT.format(row.mintedTokenCount);
}

// Resolves the palette background fill used behind Biome glyph previews.
export function resolveTerraformsBiomePreviewBackgroundColor(
	palette: readonly string[] | null
): string | null {
	return palette?.[TERRAFORMS_BIOME_BACKGROUND_COLOR_INDEX] ?? null;
}

// Resolves the color applied to a Biome glyph when a Zone palette is active.
export function resolveTerraformsBiomePreviewCharacterColor(
	palette: readonly string[] | null,
	characterIndex: number
): string | null {
	return palette?.[characterIndex] ?? null;
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

// Builds all labels needed by the reusable Biome character band component.
export function buildTerraformsBiomeCharacterLabels(input: {
	biomeIndex: number;
	characters: readonly string[];
}): readonly string[] {
	return input.characters.map((character, index) =>
		formatTerraformsBiomeCharacterLabel({
			biomeIndex: input.biomeIndex,
			position: index + 1,
			character
		})
	);
}

function compareTerraformsBiomeRows(
	left: TerraformsBiomeRow,
	right: TerraformsBiomeRow,
	column: TerraformsBiomeTableColumn
): number {
	switch (column) {
		case TERRAFORMS_BIOME_TABLE_COLUMNS.Number:
			return compareTerraformsTraitTableNumbers(left.biomeIndex, right.biomeIndex);
		case TERRAFORMS_BIOME_TABLE_COLUMNS.CharacterSet:
			return compareTerraformsTraitTableStrings(
				left.displayCharacters.join(TERRAFORMS_BIOME_CHARACTER_SEPARATOR),
				right.displayCharacters.join(TERRAFORMS_BIOME_CHARACTER_SEPARATOR)
			);
		case TERRAFORMS_BIOME_TABLE_COLUMNS.Minted:
			return compareTerraformsTraitTableNullableNumbers(
				left.mintedTokenCount,
				right.mintedTokenCount
			);
	}
}
