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
		const href = buildTerraformsHypercastleHref(
			'/ethereum/terraforms/extensions/terraforms/hypercastle',
			new URLSearchParams(
				`media_mode=artifact&${TERRAFORMS_HYPERCASTLE_QUERY_PARAMS.Catalog}=${TERRAFORMS_HYPERCASTLE_CATALOG_KEYS.Levels}`
			),
			{ levelNumber: 1 }
		);

		expect(href).toBe(
			'/ethereum/terraforms/extensions/terraforms/hypercastle?media_mode=artifact&catalog=levels&level=1&group=levels-1-4'
		);
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
});
