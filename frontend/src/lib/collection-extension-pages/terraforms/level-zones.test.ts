import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import {
	TERRAFORMS_HYPERCASTLE_LEVELS,
	TERRAFORMS_ZONES
} from '@artgod/shared/extensions/terraforms';
import {
	applyTerraformsLevelZoneTokenCounts,
	buildTerraformsAllLevelZoneRows,
	buildTerraformsLevelZoneRows,
	buildTerraformsZoneTokenHref,
	formatTerraformsZoneSupplyTokenCount,
	resolveTerraformsHypercastleLevel,
	resolveTerraformsLevelZoneAriaSort,
	resolveTerraformsLevelZoneDefaultSortDirection,
	sortTerraformsLevelZoneRows,
	TERRAFORMS_LEVEL_ZONE_ARIA_SORT_VALUES,
	TERRAFORMS_LEVEL_ZONE_SORT_DIRECTIONS,
	TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS
} from '$lib/collection-extension-pages/terraforms/level-zones';
import { formatTerraformsLevelTitle } from '$lib/collection-extension-pages/terraforms/hypercastle-selection';

describe('Terraforms level Zone table data', () => {
	it('builds selected-level Zone catalog rows with all-level table shape', () => {
		const level = TERRAFORMS_HYPERCASTLE_LEVELS.find((candidate) => candidate.levelNumber === 12);

		expect(level).toBeDefined();
		const rows = buildTerraformsLevelZoneRows(level!);

		expect(rows).toHaveLength(level!.zones.length);
		expect(rows.map((row) => row.name)).toEqual(['Palace', 'Muxtai X1']);
		expect(rows[0]!.palette).toEqual(level!.zones[0]!.palette);
		expect(rows[1]!.palette).toEqual(level!.zones[1]!.palette);
	});

	it('builds the all-level Zone catalog', () => {
		const rows = buildTerraformsAllLevelZoneRows();

		expect(rows).toHaveLength(TERRAFORMS_ZONES.length);
		expect(rows[0]).toMatchObject({
			zoneIndex: 0,
			name: 'Alto'
		});
	});

	it('sorts selected-level Zone rows by dynamic table columns', () => {
		const rows = buildTerraformsLevelZoneRows(resolveTerraformsHypercastleLevel(12)!);

		expect(
			sortTerraformsLevelZoneRows(
				rows,
				TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Name,
				TERRAFORMS_LEVEL_ZONE_SORT_DIRECTIONS.Ascending
			).map((row) => row.name)
		).toEqual(['Muxtai X1', 'Palace']);

		const countedRows = applyTerraformsLevelZoneTokenCounts(
			rows,
			{
				Palace: 2,
				'Muxtai X1': 5
			},
			true
		);
		expect(
			sortTerraformsLevelZoneRows(
				countedRows,
				TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Supply,
				TERRAFORMS_LEVEL_ZONE_SORT_DIRECTIONS.Descending
			).map((row) => row.name)
		).toEqual(['Muxtai X1', 'Palace']);
	});

	it('applies supply token counts to Zone rows for display and sorting', () => {
		const rows = applyTerraformsLevelZoneTokenCounts(
			buildTerraformsAllLevelZoneRows().filter((row) => row.name === 'Alto' || row.name === 'Holo'),
			{
				Alto: 3,
				Holo: 12
			},
			true
		);

		expect(rows.map((row) => formatTerraformsZoneSupplyTokenCount(row))).toEqual(['3', '12']);
		expect(
			sortTerraformsLevelZoneRows(
				rows,
				TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Supply,
				TERRAFORMS_LEVEL_ZONE_SORT_DIRECTIONS.Descending
			).map((row) => row.name)
		).toEqual(['Holo', 'Alto']);
	});

	it('filters selected-level Zone rows to exact trait supply counts', () => {
		const rows = applyTerraformsLevelZoneTokenCounts(
			buildTerraformsLevelZoneRows(resolveTerraformsHypercastleLevel(12)!),
			{
				Palace: 0,
				'Muxtai X1': 5
			},
			true,
			{ nonzeroSupplyOnly: true }
		);

		expect(rows.map((row) => row.name)).toEqual(['Muxtai X1']);
		expect(rows.map((row) => formatTerraformsZoneSupplyTokenCount(row))).toEqual(['5']);
	});

	it('keeps table labels and aria-sort values centralized', () => {
		expect(formatTerraformsLevelTitle(12)).toBe('Level 12');
		expect(resolveTerraformsHypercastleLevel(null)).toBeNull();
		expect(
			resolveTerraformsLevelZoneDefaultSortDirection(TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Name)
		).toBe(TERRAFORMS_LEVEL_ZONE_SORT_DIRECTIONS.Ascending);
		expect(
			resolveTerraformsLevelZoneAriaSort(
				TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Name,
				TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Name,
				TERRAFORMS_LEVEL_ZONE_SORT_DIRECTIONS.Ascending
			)
		).toBe(TERRAFORMS_LEVEL_ZONE_ARIA_SORT_VALUES.Ascending);
		expect(
			resolveTerraformsLevelZoneAriaSort(
				TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Palette,
				TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Name,
				TERRAFORMS_LEVEL_ZONE_SORT_DIRECTIONS.Descending
			)
		).toBe(TERRAFORMS_LEVEL_ZONE_ARIA_SORT_VALUES.None);
	});

	it('builds Zone token-filter hrefs for the pure token browser', () => {
		expect(
			buildTerraformsZoneTokenHref({
				basePath: '/ethereum/terraforms',
				zoneName: 'Alto'
			})
		).toBe(
			`/ethereum/terraforms?limit=${DEFAULT_PAGE_LIMIT}&mode=grid&token_status=all&traits=Zone%3AAlto`
		);
	});
});
