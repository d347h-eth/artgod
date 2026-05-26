import { describe, expect, it } from 'vitest';
import {
	buildTerraformsHypercastleSurfaceTextureCells,
	isTerraformsHypercastleSurfaceTextureLevel,
	resolveTerraformsHypercastleSurfaceTextureBackgroundColor,
	resolveTerraformsHypercastleSurfaceTextureLevel,
	resolveTerraformsHypercastleSurfaceTexturePatternFill,
	resolveTerraformsHypercastleSurfaceTextureZone,
	TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_DOM,
	TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_EXPERIMENT,
	TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_GRID_SIZE
} from '$lib/collection-extension-pages/terraforms/hypercastle-surface-texture';

describe('Terraforms Hypercastle surface texture', () => {
	it('targets Level 14 and the Holo palette for the first texture experiment', () => {
		const level = resolveTerraformsHypercastleSurfaceTextureLevel();
		const zone = resolveTerraformsHypercastleSurfaceTextureZone();

		expect(level.levelNumber).toBe(TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_EXPERIMENT.levelNumber);
		expect(zone.index).toBe(TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_EXPERIMENT.zoneIndex);
		expect(isTerraformsHypercastleSurfaceTextureLevel(level.levelNumber)).toBe(true);
		expect(resolveTerraformsHypercastleSurfaceTextureBackgroundColor()).toBe(
			zone.palette[zone.palette.length - 1]
		);
		expect(resolveTerraformsHypercastleSurfaceTexturePatternFill()).toBe(
			`url(#${TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_DOM.ids.pattern})`
		);
	});

	it('generates one deterministic texture cell per parcel-local heightmap unit', () => {
		const zone = resolveTerraformsHypercastleSurfaceTextureZone();
		const cells = buildTerraformsHypercastleSurfaceTextureCells({ seed: 0 });
		const rerolledCells = buildTerraformsHypercastleSurfaceTextureCells({ seed: 1 });

		expect(cells).toHaveLength(TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_GRID_SIZE ** 2);
		expect(cells[0]).toMatchObject({ x: 0, y: 0 });
		expect(new Set(cells.map((cell) => cell.color)).size).toBeGreaterThan(6);
		expect(cells.every((cell) => zone.palette.includes(cell.color))).toBe(true);
		expect(new Set(cells.map((cell) => cell.heightmapIndex))).toContain(0);
		expect(new Set(cells.map((cell) => cell.heightmapIndex))).toContain(8);
		expect(cells.map((cell) => cell.color).join()).not.toBe(
			rerolledCells.map((cell) => cell.color).join()
		);
	});
});
