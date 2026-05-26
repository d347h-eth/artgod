import { describe, expect, it } from 'vitest';
import {
	TERRAFORMS_HYPERCASTLE_LEVELS,
	TERRAFORMS_ZONES
} from '@artgod/shared/extensions/terraforms';
import {
	buildTerraformsHypercastleLevelSurfaces,
	buildTerraformsHypercastleSurfaceTextureRenderKey,
	buildTerraformsHypercastleSurfaceTextureCells,
	replaceTerraformsHypercastleLevelSurface,
	resolveTerraformsHypercastleSurfaceForLevel,
	resolveTerraformsHypercastleSurfaceTextureBackgroundColor,
	resolveTerraformsHypercastleSurfaceTextureGridSize,
	resolveTerraformsHypercastleSurfaceTexturePalette,
	resolveTerraformsHypercastleSurfaceZone,
	TERRAFORMS_HYPERCASTLE_SURFACE_BACKGROUND_COLOR_INDEX,
	TERRAFORMS_HYPERCASTLE_SURFACE_HEIGHT_COLOR_COUNT,
	TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_RESOLUTION
} from '$lib/collection-extension-pages/terraforms/hypercastle-surface-texture';

describe('Terraforms Hypercastle surface texture', () => {
	it('builds one transient surface assignment per level', () => {
		const surfaces = buildTerraformsHypercastleLevelSurfaces({ random: () => 0 });

		expect(surfaces).toHaveLength(TERRAFORMS_HYPERCASTLE_LEVELS.length);
		for (const [index, surface] of surfaces.entries()) {
			const level = TERRAFORMS_HYPERCASTLE_LEVELS[index]!;
			expect(surface.levelNumber).toBe(level.levelNumber);
			expect(level.zones.map((zone) => zone.index)).toContain(surface.zoneIndex);
			expect(surface.seed).toBe(0);
		}

		const firstSurface = surfaces[0]!;
		const firstZone = resolveTerraformsHypercastleSurfaceZone(firstSurface);
		expect(resolveTerraformsHypercastleSurfaceTextureBackgroundColor(firstSurface)).toBe(
			firstZone.palette[firstZone.palette.length - 1]
		);
		expect(buildTerraformsHypercastleSurfaceTextureRenderKey(surfaces)).toContain(
			String(firstSurface.levelNumber)
		);
	});

	it('replaces a selected level surface with the clicked Zone palette', () => {
		const surfaces = buildTerraformsHypercastleLevelSurfaces({ random: () => 0 });
		const targetLevel = TERRAFORMS_HYPERCASTLE_LEVELS[13]!;
		const targetZone = targetLevel.zones[targetLevel.zones.length - 1]!;
		const nextSurfaces = replaceTerraformsHypercastleLevelSurface({
			surfaces,
			levelNumber: targetLevel.levelNumber,
			zoneIndex: targetZone.index,
			random: () => 0.42
		});
		const nextSurface = resolveTerraformsHypercastleSurfaceForLevel(
			nextSurfaces,
			targetLevel.levelNumber
		);

		expect(nextSurfaces).toHaveLength(surfaces.length);
		expect(nextSurface).toMatchObject({
			levelNumber: targetLevel.levelNumber,
			zoneIndex: targetZone.index,
			seed: 420000
		});
		expect(resolveTerraformsHypercastleSurfaceZone(nextSurface!).index).toBe(targetZone.index);
	});

	it('generates one deterministic texture cell per downsampled level area', () => {
		const zone = TERRAFORMS_ZONES.reduce((selected, candidate) =>
			new Set(candidate.palette).size > new Set(selected.palette).size ? candidate : selected
		);
		const level = TERRAFORMS_HYPERCASTLE_LEVELS[13]!;
		const gridSize = resolveTerraformsHypercastleSurfaceTextureGridSize(level.dimension);
		const cells = buildTerraformsHypercastleSurfaceTextureCells({
			zone,
			seed: 0,
			levelDimension: level.dimension
		});
		const rerolledCells = buildTerraformsHypercastleSurfaceTextureCells({
			zone,
			seed: 1,
			levelDimension: level.dimension
		});

		expect(gridSize).toBe(
			(level.dimension * TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_RESOLUTION.scaleNumerator) /
				TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_RESOLUTION.scaleDenominator
		);
		expect(cells.length).toBeLessThanOrEqual(gridSize ** 2);
		expect(cells[0]).toMatchObject({ x: 0, y: 0 });
		expect(cells.every((cell) => cell.width > 0 && cell.height > 0)).toBe(true);
		expect(new Set(cells.map((cell) => cell.color)).size).toBeGreaterThan(6);
		expect(cells.every((cell) => zone.palette.includes(cell.color))).toBe(true);
		expect(new Set(cells.map((cell) => cell.heightmapIndex))).toContain(0);
		expect(new Set(cells.map((cell) => cell.heightmapIndex))).toContain(8);
		expect(cells.map((cell) => cell.color).join()).not.toBe(
			rerolledCells.map((cell) => cell.color).join()
		);
	});

	it('can sample a texture from a level-specific grid size', () => {
		const zone = TERRAFORMS_ZONES[0]!;
		const level = TERRAFORMS_HYPERCASTLE_LEVELS[13]!;
		const gridSize = resolveTerraformsHypercastleSurfaceTextureGridSize(level.dimension);
		const cells = buildTerraformsHypercastleSurfaceTextureCells({
			zone,
			seed: 0,
			levelDimension: level.dimension
		});

		expect(cells.length).toBeLessThanOrEqual(gridSize ** 2);
	});

	it('merges contiguous same-color texture samples into row runs', () => {
		const level = TERRAFORMS_HYPERCASTLE_LEVELS[13]!;
		const zone = TERRAFORMS_ZONES[0]!;
		const mergedZone = {
			...zone,
			palette: zone.palette.map(() => zone.palette[0]!)
		};
		const gridSize = resolveTerraformsHypercastleSurfaceTextureGridSize(level.dimension);
		const cells = buildTerraformsHypercastleSurfaceTextureCells({
			zone: mergedZone,
			seed: 0,
			levelDimension: level.dimension
		});

		expect(cells).toHaveLength(gridSize);
		expect(cells.every((cell) => cell.width > cell.height)).toBe(true);
	});

	it('mixes the background fill color into flat mono-palette surfaces', () => {
		const monoZone = TERRAFORMS_ZONES.find(
			(zone) =>
				new Set(zone.palette.slice(0, TERRAFORMS_HYPERCASTLE_SURFACE_HEIGHT_COLOR_COUNT))
					.size === 1 &&
				zone.palette[0] !==
					zone.palette[TERRAFORMS_HYPERCASTLE_SURFACE_BACKGROUND_COLOR_INDEX]
		);

		expect(monoZone).toBeDefined();
		const texturePalette = resolveTerraformsHypercastleSurfaceTexturePalette({
			zone: monoZone!,
			seed: 42
		});
		const level = TERRAFORMS_HYPERCASTLE_LEVELS[13]!;
		const cells = buildTerraformsHypercastleSurfaceTextureCells({
			zone: monoZone!,
			seed: 42,
			levelDimension: level.dimension
		});
		const heightColors = texturePalette.slice(
			0,
			TERRAFORMS_HYPERCASTLE_SURFACE_HEIGHT_COLOR_COUNT
		);
		const backgroundColor =
			monoZone!.palette[TERRAFORMS_HYPERCASTLE_SURFACE_BACKGROUND_COLOR_INDEX];

		expect(heightColors).toContain(backgroundColor);
		expect(new Set(heightColors).size).toBe(2);
		expect(new Set(cells.map((cell) => cell.color))).toContain(backgroundColor);
	});
});
