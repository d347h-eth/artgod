type ValueOf<T> = T[keyof T];

// Sort direction literals are shared by Terraforms trait tables.
export const TERRAFORMS_TRAIT_TABLE_SORT_DIRECTIONS = {
	Ascending: 'asc',
	Descending: 'desc'
} as const;

export type TerraformsTraitTableSortDirection = ValueOf<
	typeof TERRAFORMS_TRAIT_TABLE_SORT_DIRECTIONS
>;

// Button type values used by Terraforms trait table controls.
export const TERRAFORMS_TRAIT_TABLE_BUTTON_TYPES = {
	Button: 'button'
} as const;

// Accessible sort states mirror ARIA table header values.
export const TERRAFORMS_TRAIT_TABLE_ARIA_SORT_VALUES = {
	Ascending: 'ascending',
	Descending: 'descending',
	None: 'none'
} as const;

export type TerraformsTraitTableAriaSortValue = ValueOf<
	typeof TERRAFORMS_TRAIT_TABLE_ARIA_SORT_VALUES
>;

// DOM names shared by Terraforms trait table shells.
export const TERRAFORMS_TRAIT_TABLE_DOM = {
	classes: {
		wrapper: 'table-wrap'
	}
} as const;

const TERRAFORMS_TRAIT_TABLE_SORT_LABEL_PREFIX = 'sort by';
const TERRAFORMS_TRAIT_TABLE_LABEL_SEPARATOR = ' ';

const numberCollator = new Intl.Collator(undefined, { numeric: true });

// Sorts Terraforms trait rows through each table's column comparator.
export function sortTerraformsTraitTableRows<Row, Column extends string>(
	rows: readonly Row[],
	column: Column,
	direction: TerraformsTraitTableSortDirection,
	compareRows: (left: Row, right: Row, column: Column) => number
): Row[] {
	return [...rows].sort((left, right) => {
		const directionMultiplier =
			direction === TERRAFORMS_TRAIT_TABLE_SORT_DIRECTIONS.Ascending ? 1 : -1;
		return compareRows(left, right, column) * directionMultiplier;
	});
}

// Chooses the default sort direction for a newly activated table column.
export function resolveTerraformsTraitTableDefaultSortDirection<Column extends string>(
	column: Column,
	ascendingColumns: ReadonlySet<Column>
): TerraformsTraitTableSortDirection {
	return ascendingColumns.has(column)
		? TERRAFORMS_TRAIT_TABLE_SORT_DIRECTIONS.Ascending
		: TERRAFORMS_TRAIT_TABLE_SORT_DIRECTIONS.Descending;
}

// Flips an active sort direction after the user repeats a header click.
export function toggleTerraformsTraitTableSortDirection(
	direction: TerraformsTraitTableSortDirection
): TerraformsTraitTableSortDirection {
	return direction === TERRAFORMS_TRAIT_TABLE_SORT_DIRECTIONS.Ascending
		? TERRAFORMS_TRAIT_TABLE_SORT_DIRECTIONS.Descending
		: TERRAFORMS_TRAIT_TABLE_SORT_DIRECTIONS.Ascending;
}

// Builds the accessible label for sortable Terraforms trait table headers.
export function formatTerraformsTraitTableSortLabel(label: string): string {
	return [TERRAFORMS_TRAIT_TABLE_SORT_LABEL_PREFIX, label].join(
		TERRAFORMS_TRAIT_TABLE_LABEL_SEPARATOR
	);
}

// Resolves aria-sort for the active dynamic table header.
export function resolveTerraformsTraitTableAriaSort<Column extends string>(
	column: Column,
	activeColumn: Column,
	direction: TerraformsTraitTableSortDirection
): TerraformsTraitTableAriaSortValue {
	if (column !== activeColumn) return TERRAFORMS_TRAIT_TABLE_ARIA_SORT_VALUES.None;
	return direction === TERRAFORMS_TRAIT_TABLE_SORT_DIRECTIONS.Ascending
		? TERRAFORMS_TRAIT_TABLE_ARIA_SORT_VALUES.Ascending
		: TERRAFORMS_TRAIT_TABLE_ARIA_SORT_VALUES.Descending;
}

export function compareTerraformsTraitTableNumbers(left: number, right: number): number {
	return left - right;
}

export function compareTerraformsTraitTableNullableNumbers(
	left: number | null,
	right: number | null
): number {
	if (left === null && right === null) return 0;
	if (left === null) return -1;
	if (right === null) return 1;
	return compareTerraformsTraitTableNumbers(left, right);
}

export function compareTerraformsTraitTableStrings(left: string, right: string): number {
	return numberCollator.compare(left, right);
}
