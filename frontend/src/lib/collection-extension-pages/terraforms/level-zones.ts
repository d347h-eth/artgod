import {
	TERRAFORMS_HYPERCASTLE_LEVELS,
	TERRAFORMS_TOPOGRAPHY_THRESHOLDS,
	TERRAFORMS_ZONES,
	type TerraformsLevelSummary,
	type TerraformsZone
} from '@artgod/shared/extensions/terraforms';

type ValueOf<T> = T[keyof T];

export type TerraformsLevelZoneRow = {
	key: string;
	zoneIndex: number;
	name: string;
	palette: readonly string[];
	topographyBucketCount: number | null;
	topographyHeights: readonly number[] | null;
	topographyRangeLabel: string | null;
};

// Sort columns are the stable contract between the table, tests, and URL-ready state.
export const TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS = {
	Name: 'name',
	Palette: 'palette',
	Topography: 'topography'
} as const;

export type TerraformsLevelZoneTableColumn = ValueOf<typeof TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS>;

// Sort direction literals are kept local to the Terraforms level-zone panel.
export const TERRAFORMS_LEVEL_ZONE_SORT_DIRECTIONS = {
	Ascending: 'asc',
	Descending: 'desc'
} as const;

export type TerraformsLevelZoneSortDirection = ValueOf<
	typeof TERRAFORMS_LEVEL_ZONE_SORT_DIRECTIONS
>;

// Labels used by the selected-level Zone table.
export const TERRAFORMS_LEVEL_ZONE_TABLE_LABELS: Record<TerraformsLevelZoneTableColumn, string> = {
	[TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Name]: 'name',
	[TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Palette]: 'palette',
	[TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Topography]: 'topography'
};

// Column sets keep aggregate and selected-level tables from implying unavailable data.
export const TERRAFORMS_LEVEL_ZONE_TABLE_COLUMN_SETS = {
	AllLevels: [
		TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Name,
		TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Palette
	],
	SelectedLevel: [
		TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Name,
		TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Palette,
		TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Topography
	]
} as const satisfies Record<string, readonly TerraformsLevelZoneTableColumn[]>;

// DOM names are exported so browser probes can target extension-owned detail UI.
export const TERRAFORMS_LEVEL_ZONE_TABLE_DOM = {
	testIds: {
		detailPanel: 'terraforms-hypercastle-level-detail',
		zoneTable: 'terraforms-hypercastle-level-zone-table',
		paletteSwatch: 'terraforms-hypercastle-zone-palette-swatch'
	},
	classes: {
		root: 'terraforms-hypercastle-page',
		overview: 'terraforms-hypercastle-page-overview',
		detailPanel: 'terraforms-hypercastle-level-detail',
		detailPlaceholder: 'terraforms-hypercastle-level-detail-placeholder',
		detailHeading: 'terraforms-hypercastle-level-detail-heading',
		table: 'terraforms-hypercastle-zone-table',
		sortButton: 'terraforms-hypercastle-zone-sort-button',
		palette: 'terraforms-hypercastle-zone-palette',
		paletteSwatch: 'terraforms-hypercastle-zone-palette-swatch',
		numericCell: 'terraforms-hypercastle-zone-numeric-cell'
	}
} as const;

// Button type values used by the Terraforms level-zone table controls.
export const TERRAFORMS_LEVEL_ZONE_BUTTON_TYPES = {
	Button: 'button'
} as const;

// Accessible sort states mirror ARIA table header values.
export const TERRAFORMS_LEVEL_ZONE_ARIA_SORT_VALUES = {
	Ascending: 'ascending',
	Descending: 'descending',
	None: 'none'
} as const;

const TERRAFORMS_LEVEL_ZONE_DEFAULT_SORT_COLUMN = TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Name;
const TERRAFORMS_LEVEL_ZONE_DEFAULT_SORT_DIRECTION =
	TERRAFORMS_LEVEL_ZONE_SORT_DIRECTIONS.Ascending;
const TERRAFORMS_LEVEL_ZONE_SELECTED_LEVEL_DEFAULT_SORT_COLUMN =
	TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Topography;
const TERRAFORMS_LEVEL_ZONE_ASCENDING_COLUMNS = new Set<TerraformsLevelZoneTableColumn>([
	TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Name,
	TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Palette
]);
const TERRAFORMS_LEVEL_ZONE_HEIGHT_SEPARATOR = ', ';
const TERRAFORMS_LEVEL_ZONE_LEVEL_TITLE_SEPARATOR = ' ';
const TERRAFORMS_LEVEL_ZONE_SWATCH_LABEL_PREFIX = 'palette color';
const TERRAFORMS_LEVEL_ZONE_SWATCH_LABEL_SEPARATOR = ': ';
const TERRAFORMS_LEVEL_ZONE_SORT_LABEL_PREFIX = 'sort by';
const TERRAFORMS_LEVEL_ZONE_EMPTY_STRING = '';
const TERRAFORMS_LEVEL_ZONE_RANGE_VALUE_SEPARATOR = ': ';
const TERRAFORMS_LEVEL_ZONE_RANGE_GREATER_THAN_PREFIX = '> ';
const TERRAFORMS_LEVEL_ZONE_RANGE_UPPER_PREFIX = '<= ';
const TERRAFORMS_LEVEL_ZONE_ROW_KEY_SEPARATOR = ':';
const TERRAFORMS_LEVEL_ZONE_ALL_LEVEL_ROW_KEY_PREFIX = 'zone';

const numberCollator = new Intl.Collator(undefined, { numeric: true });
// Finds the static contract summary for a selected Hypercastle level.
export function resolveTerraformsHypercastleLevel(
	levelNumber: number | null
): TerraformsLevelSummary | null {
	if (levelNumber === null) return null;
	return TERRAFORMS_HYPERCASTLE_LEVELS.find((level) => level.levelNumber === levelNumber) ?? null;
}

// Builds one row per exact topography bucket so repeated Zone windows stay visible.
export function buildTerraformsLevelZoneRows(
	level: TerraformsLevelSummary
): TerraformsLevelZoneRow[] {
	return level.zones.flatMap((zone) => buildTerraformsLevelZoneRowsForZone(level, zone));
}

// Builds the all-level Zone catalog without level-specific distribution columns.
export function buildTerraformsAllLevelZoneRows(): TerraformsLevelZoneRow[] {
	return TERRAFORMS_ZONES.map((zone) => ({
		key: [
			TERRAFORMS_LEVEL_ZONE_ALL_LEVEL_ROW_KEY_PREFIX,
			zone.index
		].join(TERRAFORMS_LEVEL_ZONE_ROW_KEY_SEPARATOR),
		zoneIndex: zone.index,
		name: zone.name,
		palette: zone.palette,
		topographyBucketCount: null,
		topographyHeights: null,
		topographyRangeLabel: null
	}));
}

// Sorts level Zone rows by the active user-selected table column.
export function sortTerraformsLevelZoneRows(
	rows: readonly TerraformsLevelZoneRow[],
	column: TerraformsLevelZoneTableColumn,
	direction: TerraformsLevelZoneSortDirection
): TerraformsLevelZoneRow[] {
	return [...rows].sort((left, right) => {
		const directionMultiplier =
			direction === TERRAFORMS_LEVEL_ZONE_SORT_DIRECTIONS.Ascending ? 1 : -1;
		return compareTerraformsLevelZoneRows(left, right, column) * directionMultiplier;
	});
}

// Chooses the default direction when a new sortable column becomes active.
export function resolveTerraformsLevelZoneDefaultSortDirection(
	column: TerraformsLevelZoneTableColumn
): TerraformsLevelZoneSortDirection {
	return TERRAFORMS_LEVEL_ZONE_ASCENDING_COLUMNS.has(column)
		? TERRAFORMS_LEVEL_ZONE_SORT_DIRECTIONS.Ascending
		: TERRAFORMS_LEVEL_ZONE_SORT_DIRECTIONS.Descending;
}

// Flips an active sort direction after the user repeats a header click.
export function toggleTerraformsLevelZoneSortDirection(
	direction: TerraformsLevelZoneSortDirection
): TerraformsLevelZoneSortDirection {
	return direction === TERRAFORMS_LEVEL_ZONE_SORT_DIRECTIONS.Ascending
		? TERRAFORMS_LEVEL_ZONE_SORT_DIRECTIONS.Descending
		: TERRAFORMS_LEVEL_ZONE_SORT_DIRECTIONS.Ascending;
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

// Formats exact contract elevation values assigned to the Zone on the selected level.
export function formatTerraformsZoneTopographyHeights(row: TerraformsLevelZoneRow): string {
	return (
		row.topographyHeights?.join(TERRAFORMS_LEVEL_ZONE_HEIGHT_SEPARATOR) ??
		TERRAFORMS_LEVEL_ZONE_EMPTY_STRING
	);
}

// Formats raw Perlin threshold ranges for the Zone's topography buckets.
export function formatTerraformsZoneTopographyRangeLabel(row: TerraformsLevelZoneRow): string {
	return row.topographyRangeLabel ?? TERRAFORMS_LEVEL_ZONE_EMPTY_STRING;
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

// Builds the accessible label for sortable level-zone table headers.
export function formatTerraformsLevelZoneSortLabel(column: TerraformsLevelZoneTableColumn): string {
	return [TERRAFORMS_LEVEL_ZONE_SORT_LABEL_PREFIX, TERRAFORMS_LEVEL_ZONE_TABLE_LABELS[column]].join(
		TERRAFORMS_LEVEL_ZONE_LEVEL_TITLE_SEPARATOR
	);
}

// Resolves aria-sort for the active dynamic table header.
export function resolveTerraformsLevelZoneAriaSort(
	column: TerraformsLevelZoneTableColumn,
	activeColumn: TerraformsLevelZoneTableColumn,
	direction: TerraformsLevelZoneSortDirection
): ValueOf<typeof TERRAFORMS_LEVEL_ZONE_ARIA_SORT_VALUES> {
	if (column !== activeColumn) return TERRAFORMS_LEVEL_ZONE_ARIA_SORT_VALUES.None;
	return direction === TERRAFORMS_LEVEL_ZONE_SORT_DIRECTIONS.Ascending
		? TERRAFORMS_LEVEL_ZONE_ARIA_SORT_VALUES.Ascending
		: TERRAFORMS_LEVEL_ZONE_ARIA_SORT_VALUES.Descending;
}

function buildTerraformsLevelZoneRowsForZone(
	level: TerraformsLevelSummary,
	zone: TerraformsZone
): TerraformsLevelZoneRow[] {
	const zoneBuckets = level.topographyZoneBuckets.filter(
		(bucket) => bucket.zoneIndex === zone.index
	);
	return zoneBuckets.map((bucket) => ({
		key: [zone.index, bucket.elevation].join(TERRAFORMS_LEVEL_ZONE_ROW_KEY_SEPARATOR),
		zoneIndex: zone.index,
		name: zone.name,
		palette: zone.palette,
		topographyBucketCount: 1,
		topographyHeights: [bucket.elevation],
		topographyRangeLabel: formatTerraformsTopographyBucketRange(bucket)
	}));
}

function compareTerraformsLevelZoneRows(
	left: TerraformsLevelZoneRow,
	right: TerraformsLevelZoneRow,
	column: TerraformsLevelZoneTableColumn
): number {
	switch (column) {
		case TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Name:
			return compareStrings(left.name, right.name);
		case TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Palette:
			return compareStrings(
				left.palette.join(TERRAFORMS_LEVEL_ZONE_EMPTY_STRING),
				right.palette.join(TERRAFORMS_LEVEL_ZONE_EMPTY_STRING)
			);
		case TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Topography:
			return compareNullableNumbers(
				resolveTerraformsLevelZoneRowPrimaryTopography(left),
				resolveTerraformsLevelZoneRowPrimaryTopography(right)
			);
	}
}

function compareNumbers(left: number, right: number): number {
	return left - right;
}

function compareNullableNumbers(left: number | null, right: number | null): number {
	if (left === null && right === null) return 0;
	if (left === null) return -1;
	if (right === null) return 1;
	return compareNumbers(left, right);
}

function compareStrings(left: string, right: string): number {
	return numberCollator.compare(left, right);
}

function resolveTerraformsLevelZoneRowPrimaryTopography(
	row: TerraformsLevelZoneRow
): number | null {
	return row.topographyHeights?.[0] ?? null;
}

function formatTerraformsTopographyBucketRange(input: {
	topographyBucketIndex: number;
	elevation: number;
}): string {
	const lowerBound = TERRAFORMS_TOPOGRAPHY_THRESHOLDS[input.topographyBucketIndex] ?? null;
	const upperBound = TERRAFORMS_TOPOGRAPHY_THRESHOLDS[input.topographyBucketIndex - 1] ?? null;
	return [String(input.elevation), formatTerraformsTopographyRawRange(lowerBound, upperBound)].join(
		TERRAFORMS_LEVEL_ZONE_RANGE_VALUE_SEPARATOR
	);
}

function formatTerraformsTopographyRawRange(
	lowerBoundExclusive: number | null,
	upperBoundInclusive: number | null
): string {
	return [
		lowerBoundExclusive === null
			? null
			: `${TERRAFORMS_LEVEL_ZONE_RANGE_GREATER_THAN_PREFIX}${lowerBoundExclusive}`,
		upperBoundInclusive === null
			? null
			: `${TERRAFORMS_LEVEL_ZONE_RANGE_UPPER_PREFIX}${upperBoundInclusive}`
	]
		.filter((part): part is string => part !== null)
		.join(TERRAFORMS_LEVEL_ZONE_LEVEL_TITLE_SEPARATOR);
}
