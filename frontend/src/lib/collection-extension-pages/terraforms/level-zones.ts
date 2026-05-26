import {
	TERRAFORMS_HYPERCASTLE_LEVELS,
	TERRAFORMS_TOPOGRAPHY_THRESHOLDS,
	TERRAFORMS_ZONE_ATTRIBUTE_KEY,
	TERRAFORMS_ZONES,
	type TerraformsLevelSummary,
	type TerraformsZone
} from '@artgod/shared/extensions/terraforms';
import { buildTerraformsHypercastleTraitTokenHref } from '$lib/collection-extension-pages/terraforms/hypercastle-token-links';

type ValueOf<T> = T[keyof T];

export type TerraformsLevelZoneRow = {
	key: string;
	zoneIndex: number;
	name: string;
	palette: readonly string[];
	levelNumbers: readonly number[];
	topographyBucketCount: number | null;
	topographyHeights: readonly number[] | null;
	topographyRangeLabel: string | null;
};

// Sort columns are the stable contract between the table, tests, and URL-ready state.
export const TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS = {
	Name: 'name',
	Palette: 'palette',
	Levels: 'levels',
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
	[TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Levels]: 'levels',
	[TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Topography]: 'topography'
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
		TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Levels
	],
	SelectedLevel: [
		TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Name,
		TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Palette,
		TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Levels,
		TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Topography
	]
} as const satisfies Record<string, readonly TerraformsLevelZoneTableColumn[]>;

// DOM names are exported so browser probes can target extension-owned detail UI.
export const TERRAFORMS_LEVEL_ZONE_TABLE_DOM = {
	testIds: {
		detailPanel: 'terraforms-hypercastle-level-detail',
		zoneTable: 'terraforms-hypercastle-level-zone-table',
		paletteSwatch: 'terraforms-hypercastle-zone-palette-swatch',
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
		sortButton: 'terraforms-hypercastle-zone-sort-button',
		tableLink: 'terraforms-hypercastle-table-link',
		levelList: 'terraforms-hypercastle-zone-level-list',
		levelButton: 'terraforms-hypercastle-zone-level-button',
		paletteCell: 'terraforms-hypercastle-zone-palette-cell',
		palette: 'terraforms-hypercastle-zone-palette',
		paletteSwatch: 'terraforms-hypercastle-zone-palette-swatch',
		paletteCopyButton: 'terraforms-hypercastle-zone-palette-copy-button',
		paletteCopyButtonCopied: 'terraforms-hypercastle-zone-palette-copy-button-copied',
		paletteCopyButtonFailed: 'terraforms-hypercastle-zone-palette-copy-button-failed',
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
	TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Palette,
	TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Levels
]);
const TERRAFORMS_LEVEL_ZONE_HEIGHT_SEPARATOR = ', ';
const TERRAFORMS_LEVEL_ZONE_LEVEL_TITLE_SEPARATOR = ' ';
const TERRAFORMS_LEVEL_ZONE_SWATCH_LABEL_PREFIX = 'palette color';
const TERRAFORMS_LEVEL_ZONE_SWATCH_LABEL_SEPARATOR = ': ';
const TERRAFORMS_LEVEL_ZONE_PALETTE_COPY_SEPARATOR = ', ';
const TERRAFORMS_LEVEL_ZONE_PALETTE_COPY_LABEL = 'copy palette';
const TERRAFORMS_LEVEL_ZONE_PALETTE_COPIED_LABEL = 'copied palette';
const TERRAFORMS_LEVEL_ZONE_PALETTE_COPY_FAILED_LABEL = 'palette copy failed';
const TERRAFORMS_LEVEL_ZONE_TOKEN_FILTER_LABEL_PREFIX = 'filter tokens by Zone';
const TERRAFORMS_LEVEL_ZONE_LEVEL_LINK_LABEL_PREFIX = 'select Level';
const TERRAFORMS_LEVEL_ZONE_SORT_LABEL_PREFIX = 'sort by';
const TERRAFORMS_LEVEL_ZONE_EMPTY_STRING = '';
const TERRAFORMS_LEVEL_ZONE_RANGE_VALUE_SEPARATOR = ': ';
const TERRAFORMS_LEVEL_ZONE_RANGE_GREATER_THAN_PREFIX = '> ';
const TERRAFORMS_LEVEL_ZONE_RANGE_UPPER_PREFIX = '<= ';
const TERRAFORMS_LEVEL_ZONE_ROW_KEY_SEPARATOR = ':';
const TERRAFORMS_LEVEL_ZONE_ALL_LEVEL_ROW_KEY_PREFIX = 'zone';
const TERRAFORMS_LEVEL_ZONE_LEVEL_SEPARATOR = ', ';

const numberCollator = new Intl.Collator(undefined, { numeric: true });
const terraformsLevelNumbersByZoneIndex = buildTerraformsLevelNumbersByZoneIndex();
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
		levelNumbers: resolveTerraformsZoneLevelNumbers(zone.index),
		topographyBucketCount: null,
		topographyHeights: null,
		topographyRangeLabel: null
	}));
}

// Builds a token-browser href filtered to one Zone name.
export function buildTerraformsZoneTokenHref(input: {
	basePath: string;
	mediaMode?: string | null;
	zoneName: string;
}): string {
	return buildTerraformsHypercastleTraitTokenHref({
		basePath: input.basePath,
		mediaMode: input.mediaMode ?? null,
		traitKey: TERRAFORMS_ZONE_ATTRIBUTE_KEY,
		traitValue: input.zoneName
	});
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

// Formats all Hypercastle levels where a Zone can occur.
export function formatTerraformsZoneLevelNumbers(row: TerraformsLevelZoneRow): string {
	return row.levelNumbers.join(TERRAFORMS_LEVEL_ZONE_LEVEL_SEPARATOR);
}

// Returns the visual separator used between linked level numbers.
export function formatTerraformsZoneLevelSeparator(): string {
	return TERRAFORMS_LEVEL_ZONE_LEVEL_SEPARATOR;
}

// Formats all palette colors for clipboard copying.
export function formatTerraformsZonePaletteCopyValue(row: TerraformsLevelZoneRow): string {
	return row.palette.join(TERRAFORMS_LEVEL_ZONE_PALETTE_COPY_SEPARATOR);
}

// Builds the accessible label for Zone token-filter links.
export function formatTerraformsZoneTokenFilterLabel(zoneName: string): string {
	return [
		TERRAFORMS_LEVEL_ZONE_TOKEN_FILTER_LABEL_PREFIX,
		zoneName
	].join(TERRAFORMS_LEVEL_ZONE_LEVEL_TITLE_SEPARATOR);
}

// Builds the accessible label for Zone level-selection links.
export function formatTerraformsZoneLevelLinkLabel(levelNumber: number): string {
	return [
		TERRAFORMS_LEVEL_ZONE_LEVEL_LINK_LABEL_PREFIX,
		String(levelNumber)
	].join(TERRAFORMS_LEVEL_ZONE_LEVEL_TITLE_SEPARATOR);
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
		levelNumbers: resolveTerraformsZoneLevelNumbers(zone.index),
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
		case TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Levels:
			return compareNumberArrays(left.levelNumbers, right.levelNumbers);
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

function compareNumberArrays(left: readonly number[], right: readonly number[]): number {
	const length = Math.min(left.length, right.length);
	for (let index = 0; index < length; index += 1) {
		const comparison = compareNumbers(left[index]!, right[index]!);
		if (comparison !== 0) return comparison;
	}
	return compareNumbers(left.length, right.length);
}

function resolveTerraformsZoneLevelNumbers(zoneIndex: number): readonly number[] {
	return terraformsLevelNumbersByZoneIndex.get(zoneIndex) ?? [];
}

function buildTerraformsLevelNumbersByZoneIndex(): ReadonlyMap<number, readonly number[]> {
	const levelsByZoneIndex = new Map<number, number[]>();
	for (const level of TERRAFORMS_HYPERCASTLE_LEVELS) {
		for (const zone of level.zones) {
			const levels = levelsByZoneIndex.get(zone.index) ?? [];
			levels.push(level.levelNumber);
			levelsByZoneIndex.set(zone.index, levels);
		}
	}
	return levelsByZoneIndex;
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
