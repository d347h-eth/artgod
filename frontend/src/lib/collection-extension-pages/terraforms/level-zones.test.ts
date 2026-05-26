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
	formatTerraformsZoneMintedTokenCount,
	formatTerraformsZoneTopographyHeights,
	formatTerraformsZoneTopographyRangeLabel,
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
	it('builds static Zone distribution rows from topography buckets', () => {
		const level = TERRAFORMS_HYPERCASTLE_LEVELS.find((candidate) => candidate.levelNumber === 12);

		expect(level).toBeDefined();
		const rows = buildTerraformsLevelZoneRows(level!);
		const sortedRows = sortTerraformsLevelZoneRows(
			rows,
			TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Topography,
			TERRAFORMS_LEVEL_ZONE_SORT_DIRECTIONS.Descending
		);

		expect(rows).toHaveLength(9);
		expect(sortedRows.map((row) => row.name)).toEqual([
			'Palace',
			'Muxtai X1',
			'Palace',
			'Muxtai X1',
			'Palace',
			'Muxtai X1',
			'Palace',
			'Muxtai X1',
			'Palace'
		]);
		expect(sortedRows.map((row) => row.topographyBucketCount)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
		expect(sortedRows.map((row) => formatTerraformsZoneTopographyHeights(row))).toEqual([
			'4',
			'3',
			'2',
			'1',
			'0',
			'-1',
			'-2',
			'-3',
			'-4'
		]);
		expect(sortedRows[0]!.palette).toEqual(level!.zones[0]!.palette);
		expect(sortedRows[1]!.palette).toEqual(level!.zones[1]!.palette);
		expect(formatTerraformsZoneTopographyRangeLabel(rows[0]!)).toContain('4: > 18000');
		expect(formatTerraformsZoneTopographyRangeLabel(sortedRows[8]!)).toContain('-4: <= -26000');
	});

	it('builds the all-level Zone catalog without level-specific buckets', () => {
		const rows = buildTerraformsAllLevelZoneRows();

		expect(rows).toHaveLength(TERRAFORMS_ZONES.length);
		expect(rows[0]).toMatchObject({
			zoneIndex: 0,
			name: 'Alto',
			topographyBucketCount: null,
			topographyHeights: null,
			topographyRangeLabel: null
		});
		expect(formatTerraformsZoneTopographyHeights(rows[0]!)).toBe('');
		expect(formatTerraformsZoneTopographyRangeLabel(rows[0]!)).toBe('');
	});

	it('sorts selected-level Zone rows by dynamic table columns', () => {
		const rows = buildTerraformsLevelZoneRows(resolveTerraformsHypercastleLevel(12)!);

		expect(
			sortTerraformsLevelZoneRows(
				rows,
				TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Topography,
				TERRAFORMS_LEVEL_ZONE_SORT_DIRECTIONS.Ascending
			).map((row) => row.name)
		).toEqual([
			'Palace',
			'Muxtai X1',
			'Palace',
			'Muxtai X1',
			'Palace',
			'Muxtai X1',
			'Palace',
			'Muxtai X1',
			'Palace'
		]);

		expect(
			sortTerraformsLevelZoneRows(
				rows,
				TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Name,
				TERRAFORMS_LEVEL_ZONE_SORT_DIRECTIONS.Ascending
			).map((row) => row.name)
		).toEqual([
			'Muxtai X1',
			'Muxtai X1',
			'Muxtai X1',
			'Muxtai X1',
			'Palace',
			'Palace',
			'Palace',
			'Palace',
			'Palace'
		]);
	});

	it('applies minted token counts to Zone rows for display and sorting', () => {
		const rows = applyTerraformsLevelZoneTokenCounts(
			buildTerraformsAllLevelZoneRows().filter((row) => row.name === 'Alto' || row.name === 'Holo'),
			{
				Alto: 3,
				Holo: 12
			},
			true
		);

		expect(rows.map((row) => formatTerraformsZoneMintedTokenCount(row))).toEqual(['3', '12']);
		expect(
			sortTerraformsLevelZoneRows(
				rows,
				TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Minted,
				TERRAFORMS_LEVEL_ZONE_SORT_DIRECTIONS.Descending
			).map((row) => row.name)
		).toEqual(['Holo', 'Alto']);
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
