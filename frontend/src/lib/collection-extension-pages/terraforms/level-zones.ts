import {
	TERRAFORMS_HYPERCASTLE_LEVELS,
	TERRAFORMS_ZONES,
	type TerraformsLevelSummary
} from '@artgod/shared/extensions/terraforms';
import {
	buildTerraformsHypercastleTokenFilterTraits,
	buildTerraformsHypercastleTraitsTokenHref,
	formatTerraformsHypercastleTokenFilterLabel
} from '$lib/collection-extension-pages/terraforms/hypercastle-token-links';
import type { TerraformsTraitCountIndex } from '$lib/collection-extension-pages/terraforms/trait-catalog-counts';
import {
	compareTerraformsTraitTableNullableNumbers,
	compareTerraformsTraitTableStrings,
	formatTerraformsTraitTableSortLabel,
	resolveTerraformsTraitTableAriaSort,
	resolveTerraformsTraitTableDefaultSortDirection,
	sortTerraformsTraitTableRows,
	TERRAFORMS_TRAIT_TABLE_ARIA_SORT_VALUES,
	TERRAFORMS_TRAIT_TABLE_BUTTON_TYPES,
	TERRAFORMS_TRAIT_TABLE_SORT_DIRECTIONS,
	toggleTerraformsTraitTableSortDirection,
	type TerraformsTraitTableSortDirection
} from '$lib/collection-extension-pages/terraforms/trait-table';

type ValueOf<T> = T[keyof T];

export type TerraformsLevelZoneRow = {
	key: string;
	zoneIndex: number;
	name: string;
	palette: readonly string[];
	supplyTokenCount: number | null;
};

// Sort columns are the stable contract between the table, tests, and URL-ready state.
export const TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS = {
	Name: 'name',
	Palette: 'palette',
	Supply: 'supply'
} as const;

export type TerraformsLevelZoneTableColumn = ValueOf<typeof TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS>;

export const TERRAFORMS_LEVEL_ZONE_SORT_DIRECTIONS = TERRAFORMS_TRAIT_TABLE_SORT_DIRECTIONS;

export type TerraformsLevelZoneSortDirection = TerraformsTraitTableSortDirection;

// Palette copy state values are shared by the table component and labels.
export const TERRAFORMS_LEVEL_ZONE_PALETTE_COPY_STATES = {
	Idle: 'idle',
	Copied: 'copied',
	Failed: 'failed'
} as const;

export type TerraformsLevelZonePaletteCopyState = ValueOf<
	typeof TERRAFORMS_LEVEL_ZONE_PALETTE_COPY_STATES
>;

// Palette-copy feedback stays visible briefly after clipboard writes complete.
export const TERRAFORMS_LEVEL_ZONE_PALETTE_COPY_FEEDBACK_DELAY_MS = 1400;

// Labels used by the selected-level Zone table.
export const TERRAFORMS_LEVEL_ZONE_TABLE_LABELS: Record<TerraformsLevelZoneTableColumn, string> = {
	[TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Name]: 'name',
	[TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Palette]: 'palette',
	[TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Supply]: 'supply'
};

// Section labels distinguish all-level detail tables.
export const TERRAFORMS_LEVEL_ZONE_SECTION_LABELS = {
	Zones: 'zones'
} as const;

// Column sets keep aggregate and selected-level tables from implying unavailable data.
export const TERRAFORMS_LEVEL_ZONE_TABLE_COLUMN_SETS = {
	AllLevels: [
		TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Name,
		TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Palette,
		TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Supply
	],
	SelectedLevel: [
		TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Name,
		TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Palette,
		TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Supply
	]
} as const satisfies Record<string, readonly TerraformsLevelZoneTableColumn[]>;

// DOM names are exported so browser probes can target extension-owned detail UI.
export const TERRAFORMS_LEVEL_ZONE_TABLE_DOM = {
	testIds: {
		detailPanel: 'terraforms-hypercastle-level-detail',
		zoneTable: 'terraforms-hypercastle-level-zone-table',
		paletteCopyButton: 'terraforms-hypercastle-zone-palette-copy'
	},
	classes: {
		root: 'terraforms-hypercastle-page',
		overview: 'terraforms-hypercastle-page-overview',
		detailPanel: 'terraforms-hypercastle-level-detail',
		detailPlaceholder: 'terraforms-hypercastle-level-detail-placeholder',
		detailHeading: 'terraforms-hypercastle-level-detail-heading',
		detailSubheading: 'terraforms-hypercastle-level-detail-subheading',
		table: 'terraforms-hypercastle-zone-table',
		tableLink: 'terraforms-hypercastle-table-link',
		paletteCell: 'terraforms-hypercastle-zone-palette-cell',
		paletteCopyButton: 'terraforms-hypercastle-zone-palette-copy-button',
		paletteCopyButtonCopied: 'terraforms-hypercastle-zone-palette-copy-button-copied',
		paletteCopyButtonFailed: 'terraforms-hypercastle-zone-palette-copy-button-failed',
		numericCell: 'terraforms-hypercastle-zone-numeric-cell'
	}
} as const;

export const TERRAFORMS_LEVEL_ZONE_BUTTON_TYPES = TERRAFORMS_TRAIT_TABLE_BUTTON_TYPES;

export const TERRAFORMS_LEVEL_ZONE_ARIA_SORT_VALUES = TERRAFORMS_TRAIT_TABLE_ARIA_SORT_VALUES;

const TERRAFORMS_LEVEL_ZONE_DEFAULT_SORT_COLUMN = TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Name;
const TERRAFORMS_LEVEL_ZONE_DEFAULT_SORT_DIRECTION =
	TERRAFORMS_LEVEL_ZONE_SORT_DIRECTIONS.Ascending;
const TERRAFORMS_LEVEL_ZONE_SELECTED_LEVEL_DEFAULT_SORT_COLUMN =
	TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Name;
const TERRAFORMS_LEVEL_ZONE_ASCENDING_COLUMNS = new Set<TerraformsLevelZoneTableColumn>([
	TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Name,
	TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Palette
]);
const TERRAFORMS_LEVEL_ZONE_LEVEL_TITLE_SEPARATOR = ' ';
const TERRAFORMS_LEVEL_ZONE_SWATCH_LABEL_PREFIX = 'palette color';
const TERRAFORMS_LEVEL_ZONE_SWATCH_LABEL_SEPARATOR = ': ';
const TERRAFORMS_LEVEL_ZONE_PALETTE_COPY_SEPARATOR = ', ';
const TERRAFORMS_LEVEL_ZONE_PALETTE_COPY_LABEL = 'copy palette';
const TERRAFORMS_LEVEL_ZONE_PALETTE_COPIED_LABEL = 'copied palette';
const TERRAFORMS_LEVEL_ZONE_PALETTE_COPY_FAILED_LABEL = 'palette copy failed';
const TERRAFORMS_LEVEL_ZONE_EMPTY_STRING = '';
const TERRAFORMS_LEVEL_ZONE_COUNT_FORMAT = new Intl.NumberFormat(undefined, {
	maximumFractionDigits: 0
});
const TERRAFORMS_LEVEL_ZONE_ROW_KEY_SEPARATOR = ':';
const TERRAFORMS_LEVEL_ZONE_ALL_LEVEL_ROW_KEY_PREFIX = 'zone';
const TERRAFORMS_LEVEL_ZONE_LEVEL_ROW_KEY_PREFIX = 'level-zone';
// Finds the static contract summary for a selected Hypercastle level.
export function resolveTerraformsHypercastleLevel(
	levelNumber: number | null
): TerraformsLevelSummary | null {
	if (levelNumber === null) return null;
	return TERRAFORMS_HYPERCASTLE_LEVELS.find((level) => level.levelNumber === levelNumber) ?? null;
}

// Builds the selected-level Zone catalog with the same shape used by the all-level table.
export function buildTerraformsLevelZoneRows(
	level: TerraformsLevelSummary
): TerraformsLevelZoneRow[] {
	return level.zones.map((zone) => ({
		key: [TERRAFORMS_LEVEL_ZONE_LEVEL_ROW_KEY_PREFIX, level.levelNumber, zone.index].join(
			TERRAFORMS_LEVEL_ZONE_ROW_KEY_SEPARATOR
		),
		zoneIndex: zone.index,
		name: zone.name,
		palette: zone.palette,
		supplyTokenCount: null
	}));
}

// Builds the all-level Zone catalog.
export function buildTerraformsAllLevelZoneRows(): TerraformsLevelZoneRow[] {
	return TERRAFORMS_ZONES.map((zone) => ({
		key: [TERRAFORMS_LEVEL_ZONE_ALL_LEVEL_ROW_KEY_PREFIX, zone.index].join(
			TERRAFORMS_LEVEL_ZONE_ROW_KEY_SEPARATOR
		),
		zoneIndex: zone.index,
		name: zone.name,
		palette: zone.palette,
		supplyTokenCount: null
	}));
}

// Applies trait supply counts after the backend catalog response arrives.
export function applyTerraformsLevelZoneTokenCounts(
	rows: readonly TerraformsLevelZoneRow[],
	counts: TerraformsTraitCountIndex,
	countsLoaded: boolean,
	options: { nonzeroSupplyOnly?: boolean } = {}
): TerraformsLevelZoneRow[] {
	const countedRows = rows.map((row) => ({
		...row,
		supplyTokenCount: countsLoaded ? (counts[row.name] ?? 0) : null
	}));
	if (!options.nonzeroSupplyOnly) {
		return countedRows;
	}
	return countsLoaded
		? countedRows.filter((row) => row.supplyTokenCount !== null && row.supplyTokenCount > 0)
		: [];
}

// Builds a token-browser href filtered to the active Level and one Zone name.
export function buildTerraformsZoneTokenHref(input: {
	basePath: string;
	mediaMode?: string | null;
	levelNumber?: number | null;
	zoneName: string;
}): string {
	return buildTerraformsHypercastleTraitsTokenHref({
		basePath: input.basePath,
		mediaMode: input.mediaMode ?? null,
		traits: buildTerraformsHypercastleTokenFilterTraits({
			levelNumber: input.levelNumber,
			zoneName: input.zoneName
		})
	});
}

// Sorts level Zone rows by the active user-selected table column.
export function sortTerraformsLevelZoneRows(
	rows: readonly TerraformsLevelZoneRow[],
	column: TerraformsLevelZoneTableColumn,
	direction: TerraformsLevelZoneSortDirection
): TerraformsLevelZoneRow[] {
	return sortTerraformsTraitTableRows(rows, column, direction, compareTerraformsLevelZoneRows);
}

// Chooses the default direction when a new sortable column becomes active.
export function resolveTerraformsLevelZoneDefaultSortDirection(
	column: TerraformsLevelZoneTableColumn
): TerraformsLevelZoneSortDirection {
	return resolveTerraformsTraitTableDefaultSortDirection(
		column,
		TERRAFORMS_LEVEL_ZONE_ASCENDING_COLUMNS
	);
}

// Flips an active sort direction after the user repeats a header click.
export function toggleTerraformsLevelZoneSortDirection(
	direction: TerraformsLevelZoneSortDirection
): TerraformsLevelZoneSortDirection {
	return toggleTerraformsTraitTableSortDirection(direction);
}

// Exposes the initial table state without duplicating literals in the component.
export function defaultTerraformsLevelZoneSortColumn(): TerraformsLevelZoneTableColumn {
	return TERRAFORMS_LEVEL_ZONE_DEFAULT_SORT_COLUMN;
}

// Exposes the initial table state without duplicating literals in the component.
export function defaultTerraformsLevelZoneSortDirection(): TerraformsLevelZoneSortDirection {
	return TERRAFORMS_LEVEL_ZONE_DEFAULT_SORT_DIRECTION;
}

// Exposes the selected-level initial table state without duplicating literals.
export function defaultTerraformsSelectedLevelZoneSortColumn(): TerraformsLevelZoneTableColumn {
	return TERRAFORMS_LEVEL_ZONE_SELECTED_LEVEL_DEFAULT_SORT_COLUMN;
}

// Exposes the selected-level initial table state without duplicating literals.
export function defaultTerraformsSelectedLevelZoneSortDirection(): TerraformsLevelZoneSortDirection {
	return resolveTerraformsLevelZoneDefaultSortDirection(
		TERRAFORMS_LEVEL_ZONE_SELECTED_LEVEL_DEFAULT_SORT_COLUMN
	);
}

// Formats exact supply token counts once the trait catalog has loaded.
export function formatTerraformsZoneSupplyTokenCount(row: TerraformsLevelZoneRow): string {
	return row.supplyTokenCount === null
		? TERRAFORMS_LEVEL_ZONE_EMPTY_STRING
		: TERRAFORMS_LEVEL_ZONE_COUNT_FORMAT.format(row.supplyTokenCount);
}

// Formats all palette colors for clipboard copying.
export function formatTerraformsZonePaletteCopyValue(row: TerraformsLevelZoneRow): string {
	return row.palette.join(TERRAFORMS_LEVEL_ZONE_PALETTE_COPY_SEPARATOR);
}

// Builds the accessible label for a Zone link with its active Level scope.
export function formatTerraformsZoneTokenFilterLabel(input: {
	levelNumber?: number | null;
	zoneName: string;
}): string {
	return formatTerraformsHypercastleTokenFilterLabel(
		buildTerraformsHypercastleTokenFilterTraits(input)
	);
}

// Builds the accessible label for palette-copy state.
export function formatTerraformsZonePaletteCopyLabel(
	state: TerraformsLevelZonePaletteCopyState
): string {
	if (state === TERRAFORMS_LEVEL_ZONE_PALETTE_COPY_STATES.Copied) {
		return TERRAFORMS_LEVEL_ZONE_PALETTE_COPIED_LABEL;
	}
	if (state === TERRAFORMS_LEVEL_ZONE_PALETTE_COPY_STATES.Failed) {
		return TERRAFORMS_LEVEL_ZONE_PALETTE_COPY_FAILED_LABEL;
	}
	return TERRAFORMS_LEVEL_ZONE_PALETTE_COPY_LABEL;
}

// Builds an accessible label for individual palette swatches.
export function formatTerraformsZonePaletteSwatchLabel(input: {
	zoneName: string;
	color: string;
	position: number;
}): string {
	return (
		[input.zoneName, TERRAFORMS_LEVEL_ZONE_SWATCH_LABEL_PREFIX, String(input.position)].join(
			TERRAFORMS_LEVEL_ZONE_LEVEL_TITLE_SEPARATOR
		) +
		TERRAFORMS_LEVEL_ZONE_SWATCH_LABEL_SEPARATOR +
		input.color
	);
}

// Builds all labels needed by the reusable Zone palette band component.
export function buildTerraformsZonePaletteSwatchLabels(input: {
	zoneName: string;
	palette: readonly string[];
}): readonly string[] {
	return input.palette.map((color, index) =>
		formatTerraformsZonePaletteSwatchLabel({
			zoneName: input.zoneName,
			color,
			position: index + 1
		})
	);
}

// Builds the accessible label for sortable level-zone table headers.
export function formatTerraformsLevelZoneSortLabel(column: TerraformsLevelZoneTableColumn): string {
	return formatTerraformsTraitTableSortLabel(TERRAFORMS_LEVEL_ZONE_TABLE_LABELS[column]);
}

// Resolves aria-sort for the active dynamic table header.
export function resolveTerraformsLevelZoneAriaSort(
	column: TerraformsLevelZoneTableColumn,
	activeColumn: TerraformsLevelZoneTableColumn,
	direction: TerraformsLevelZoneSortDirection
): ValueOf<typeof TERRAFORMS_LEVEL_ZONE_ARIA_SORT_VALUES> {
	return resolveTerraformsTraitTableAriaSort(column, activeColumn, direction);
}

function compareTerraformsLevelZoneRows(
	left: TerraformsLevelZoneRow,
	right: TerraformsLevelZoneRow,
	column: TerraformsLevelZoneTableColumn
): number {
	switch (column) {
		case TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Name:
			return compareTerraformsTraitTableStrings(left.name, right.name);
		case TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Palette:
			return compareTerraformsTraitTableStrings(
				left.palette.join(TERRAFORMS_LEVEL_ZONE_EMPTY_STRING),
				right.palette.join(TERRAFORMS_LEVEL_ZONE_EMPTY_STRING)
			);
		case TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Supply:
			return compareTerraformsTraitTableNullableNumbers(
				left.supplyTokenCount,
				right.supplyTokenCount
			);
	}
}
