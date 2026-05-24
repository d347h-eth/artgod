import { describe, expect, it } from 'vitest';
import {
	buildTerraformsBiomeCatalogRows,
	buildTerraformsHypercastleHref,
	buildTerraformsLevelCatalogRows,
	buildTerraformsZoneCatalogRows,
	resolveTerraformsHypercastleState,
	sortTerraformsLevelCatalogRows,
	sortTerraformsZoneCatalogRows
} from '$lib/collection-extension-pages/terraforms/hypercastle-catalog';
import {
	TERRAFORMS_HYPERCASTLE_CATALOG_KEYS,
	TERRAFORMS_HYPERCASTLE_QUERY_PARAMS,
	TERRAFORMS_HYPERCASTLE_SORT_DIRECTIONS,
	TERRAFORMS_HYPERCASTLE_SORT_KEYS
} from '$lib/collection-extension-pages/terraforms/constants';
import {
	buildTerraformsHypercastleIsometricBands,
	resolveTerraformsHypercastleSelectedBucket
} from '$lib/collection-extension-pages/terraforms/hypercastle-isometric-level';
import {
	COLLECTION_MEDIA_MODES,
	COLLECTION_MEDIA_QUERY_PARAMS
} from '@artgod/shared/extensions';
import {
	TERRAFORMS_HYPERCASTLE_LEVEL_GROUPS,
	TERRAFORMS_HYPERCASTLE_LEVELS
} from '@artgod/shared/extensions/terraforms';

describe('Terraforms Hypercastle catalog helpers', () => {
	it('resolves selected levels to their Zone-set group', () => {
		const params = new URLSearchParams();
		params.set(TERRAFORMS_HYPERCASTLE_QUERY_PARAMS.Level, '13');
		params.set(TERRAFORMS_HYPERCASTLE_QUERY_PARAMS.Catalog, TERRAFORMS_HYPERCASTLE_CATALOG_KEYS.Zones);
		params.set(TERRAFORMS_HYPERCASTLE_QUERY_PARAMS.Sort, TERRAFORMS_HYPERCASTLE_SORT_KEYS.Buckets);
		params.set(TERRAFORMS_HYPERCASTLE_QUERY_PARAMS.Direction, TERRAFORMS_HYPERCASTLE_SORT_DIRECTIONS.Desc);
		const state = resolveTerraformsHypercastleState(params);

		expect(state.selectedLevel?.levelNumber).toBe(13);
		expect(state.selectedGroup?.levelNumbers).toEqual([13]);
		expect(state.catalog).toBe(TERRAFORMS_HYPERCASTLE_CATALOG_KEYS.Zones);
		expect(state.sort).toBe(TERRAFORMS_HYPERCASTLE_SORT_KEYS.Buckets);
		expect(state.direction).toBe(TERRAFORMS_HYPERCASTLE_SORT_DIRECTIONS.Desc);
	});

	it('builds shareable focus hrefs without dropping unrelated query params', () => {
		const pathname = '/ethereum/terraforms/extensions/terraforms/hypercastle';
		const currentParams = new URLSearchParams();
		currentParams.set(COLLECTION_MEDIA_QUERY_PARAMS.MediaMode, COLLECTION_MEDIA_MODES.Artifact);
		currentParams.set(
			TERRAFORMS_HYPERCASTLE_QUERY_PARAMS.Catalog,
			TERRAFORMS_HYPERCASTLE_CATALOG_KEYS.Levels
		);
		const expectedParams = new URLSearchParams(currentParams);
		expectedParams.set(TERRAFORMS_HYPERCASTLE_QUERY_PARAMS.Level, String(1));
		expectedParams.set(
			TERRAFORMS_HYPERCASTLE_QUERY_PARAMS.Group,
			TERRAFORMS_HYPERCASTLE_LEVEL_GROUPS[0]!.groupId
		);
		const href = buildTerraformsHypercastleHref(
			pathname,
			currentParams,
			{ levelNumber: 1 }
		);

		expect(href).toBe(`${pathname}?${expectedParams.toString()}`);
	});

	it('builds level rows with parcel and available-biome totals', () => {
		const rows = buildTerraformsLevelCatalogRows();
		const sorted = sortTerraformsLevelCatalogRows(
			rows,
			TERRAFORMS_HYPERCASTLE_SORT_KEYS.Parcels,
			TERRAFORMS_HYPERCASTLE_SORT_DIRECTIONS.Desc
		);

		expect(rows).toHaveLength(20);
		expect(rows[12]).toMatchObject({
			level: { levelNumber: 13, parcelCount: 2304 },
			availableBiomeCount: 83
		});
		expect(sorted.slice(0, 2).map((row) => row.level.levelNumber)).toEqual([13, 14]);
	});

	it('builds Zone rows from contract topography bucket availability', () => {
		const rows = buildTerraformsZoneCatalogRows();
		const lastZone = rows.at(-1);
		const sorted = sortTerraformsZoneCatalogRows(
			rows,
			TERRAFORMS_HYPERCASTLE_SORT_KEYS.Buckets,
			TERRAFORMS_HYPERCASTLE_SORT_DIRECTIONS.Desc
		);

		expect(rows).toHaveLength(75);
		expect(lastZone?.levelNumbers).toEqual([1, 2, 3, 4]);
		expect(lastZone?.topographyBuckets).toBe(36);
		expect(sorted[0].topographyBuckets).toBeGreaterThanOrEqual(sorted[1].topographyBuckets);
	});

	it('builds Biome rows from nonzero biome-group level weights', () => {
		const rows = buildTerraformsBiomeCatalogRows();
		const firstBiome = rows[0];

		expect(rows).toHaveLength(92);
		expect(firstBiome.levelNumbers).toContain(13);
		expect(firstBiome.maxWeightPercent).toBe(50);
		expect(firstBiome.resourceCount).toBe(0);
	});

	it('builds aggregate isometric topography bands for focused levels', () => {
		const level = TERRAFORMS_HYPERCASTLE_LEVELS[12]!;
		const bands = buildTerraformsHypercastleIsometricBands(level);
		const firstBand = bands[0]!;
		const lastBand = bands.at(-1)!;
		const bandZoneIndices = new Set(bands.map((band) => band.zone.index));
		const bucketZoneIndices = new Set(
			level.topographyZoneBuckets.map((bucket) => bucket.zoneIndex)
		);

		expect(bands).toHaveLength(9);
		expect(firstBand.bucket.topographyBucketIndex).toBe(8);
		expect(lastBand.bucket.topographyBucketIndex).toBe(0);
		expect(firstBand.width).toBeGreaterThan(lastBand.width);
		expect(bandZoneIndices).toEqual(bucketZoneIndices);
	});

	it('keeps focused isometric bucket selection inside the level topography domain', () => {
		const level = TERRAFORMS_HYPERCASTLE_LEVELS[12]!;

		expect(resolveTerraformsHypercastleSelectedBucket(level, 8).topographyBucketIndex).toBe(8);
		expect(resolveTerraformsHypercastleSelectedBucket(level, 99).topographyBucketIndex).toBe(0);
	});
});
