import { describe, expect, it } from 'vitest';
import { TERRAFORMS_HYPERCASTLE_LEVELS } from '@artgod/shared/extensions/terraforms';
import {
	buildTerraformsLevelZoneRows,
	formatTerraformsLevelTitle,
	formatTerraformsZoneBucketCount,
	formatTerraformsZoneBucketShare,
	resolveTerraformsHypercastleLevel,
	resolveTerraformsLevelZoneAriaSort,
	resolveTerraformsLevelZoneDefaultSortDirection,
	sortTerraformsLevelZoneRows,
	TERRAFORMS_LEVEL_ZONE_ARIA_SORT_VALUES,
	TERRAFORMS_LEVEL_ZONE_SORT_DIRECTIONS,
	TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS
} from '$lib/collection-extension-pages/terraforms/level-zones';

describe('Terraforms level Zone table data', () => {
	it('builds static Zone distribution rows from topography buckets', () => {
		const level = TERRAFORMS_HYPERCASTLE_LEVELS.find((candidate) => candidate.levelNumber === 12);

		expect(level).toBeDefined();
		const rows = buildTerraformsLevelZoneRows(level!);

		expect(rows.map((row) => row.name)).toEqual(['Palace', 'Muxtai X1']);
		expect(rows.map((row) => row.topographyBucketCount)).toEqual([5, 4]);
		expect(rows.map((row) => row.palette)).toEqual(level!.zones.map((zone) => zone.palette));
		expect(formatTerraformsZoneBucketCount(rows[0]!)).toBe('5 / 9');
		expect(formatTerraformsZoneBucketShare(rows[0]!)).toBe('55.6%');
	});

	it('sorts selected-level Zone rows by dynamic table columns', () => {
		const rows = buildTerraformsLevelZoneRows(resolveTerraformsHypercastleLevel(12)!);

		expect(
			sortTerraformsLevelZoneRows(
				rows,
				TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.TopographyBuckets,
				TERRAFORMS_LEVEL_ZONE_SORT_DIRECTIONS.Ascending
			).map((row) => row.name)
		).toEqual(['Muxtai X1', 'Palace']);

		expect(
			sortTerraformsLevelZoneRows(
				rows,
				TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Name,
				TERRAFORMS_LEVEL_ZONE_SORT_DIRECTIONS.Ascending
			).map((row) => row.name)
		).toEqual(['Muxtai X1', 'Palace']);
	});

	it('keeps table labels and aria-sort values centralized', () => {
		expect(formatTerraformsLevelTitle(12)).toBe('Level 12');
		expect(resolveTerraformsHypercastleLevel(null)).toBeNull();
		expect(
			resolveTerraformsLevelZoneDefaultSortDirection(TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Name)
		).toBe(TERRAFORMS_LEVEL_ZONE_SORT_DIRECTIONS.Ascending);
		expect(
			resolveTerraformsLevelZoneAriaSort(
				TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.BucketShare,
				TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.BucketShare,
				TERRAFORMS_LEVEL_ZONE_SORT_DIRECTIONS.Descending
			)
		).toBe(TERRAFORMS_LEVEL_ZONE_ARIA_SORT_VALUES.Descending);
		expect(
			resolveTerraformsLevelZoneAriaSort(
				TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Name,
				TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.BucketShare,
				TERRAFORMS_LEVEL_ZONE_SORT_DIRECTIONS.Descending
			)
		).toBe(TERRAFORMS_LEVEL_ZONE_ARIA_SORT_VALUES.None);
	});
});
