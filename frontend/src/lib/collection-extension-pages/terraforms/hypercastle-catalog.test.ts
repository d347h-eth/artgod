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

describe('Terraforms Hypercastle catalog helpers', () => {
	it('resolves selected levels to their Zone-set group', () => {
		const state = resolveTerraformsHypercastleState(
			new URLSearchParams('level=13&catalog=zones&sort=buckets&dir=desc')
		);

		expect(state.selectedLevel?.levelNumber).toBe(13);
		expect(state.selectedGroup?.levelNumbers).toEqual([13]);
		expect(state.catalog).toBe('zones');
		expect(state.sort).toBe('buckets');
		expect(state.direction).toBe('desc');
	});

	it('builds shareable focus hrefs without dropping unrelated query params', () => {
		const href = buildTerraformsHypercastleHref(
			'/ethereum/terraforms/extensions/terraforms/hypercastle',
			new URLSearchParams('media_mode=artifact&catalog=levels'),
			{ levelNumber: 1 }
		);

		expect(href).toBe(
			'/ethereum/terraforms/extensions/terraforms/hypercastle?media_mode=artifact&catalog=levels&level=1&group=levels-1-4'
		);
	});

	it('builds level rows with parcel and available-biome totals', () => {
		const rows = buildTerraformsLevelCatalogRows();
		const sorted = sortTerraformsLevelCatalogRows(rows, 'parcels', 'desc');

		expect(rows).toHaveLength(20);
		expect(rows[12]).toMatchObject({
			level: { levelNumber: 13, parcelCount: 2304 },
			availableBiomeCount: 83
		});
		expect(sorted.slice(0, 2).map((row) => row.level.levelNumber)).toEqual([13, 14]);
	});

	it('builds Zone rows from contract topography bucket availability', () => {
		const rows = buildTerraformsZoneCatalogRows();
		const kairo = rows.find((row) => row.zone.name === 'Kairo');
		const sorted = sortTerraformsZoneCatalogRows(rows, 'buckets', 'desc');

		expect(rows).toHaveLength(75);
		expect(kairo?.levelNumbers).toEqual([1, 2, 3, 4]);
		expect(kairo?.topographyBuckets).toBe(36);
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
