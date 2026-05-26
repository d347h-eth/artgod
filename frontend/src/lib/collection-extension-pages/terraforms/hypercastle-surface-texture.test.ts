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
	resolveTerraformsHypercastleSurfaceTexturePalette,
	resolveTerraformsHypercastleSurfaceTexturePatternId,
	resolveTerraformsHypercastleSurfaceTexturePatternFill,
	resolveTerraformsHypercastleSurfaceZone,
	TERRAFORMS_HYPERCASTLE_SURFACE_BACKGROUND_COLOR_INDEX,
	TERRAFORMS_HYPERCASTLE_SURFACE_HEIGHT_COLOR_COUNT,
	TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_DOM,
	TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_GRID_SIZE
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
		expect(resolveTerraformsHypercastleSurfaceTexturePatternId(firstSurface.levelNumber)).toBe(
			`${TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_DOM.ids.patternPrefix}${firstSurface.levelNumber}`
		);
		expect(resolveTerraformsHypercastleSurfaceTexturePatternFill(firstSurface.levelNumber)).toBe(
			`url(#${resolveTerraformsHypercastleSurfaceTexturePatternId(firstSurface.levelNumber)})`
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

	it('generates one deterministic texture cell per parcel-local heightmap unit', () => {
		const zone = TERRAFORMS_ZONES.reduce((selected, candidate) =>
			new Set(candidate.palette).size > new Set(selected.palette).size ? candidate : selected
		);
		const cells = buildTerraformsHypercastleSurfaceTextureCells({ zone, seed: 0 });
		const rerolledCells = buildTerraformsHypercastleSurfaceTextureCells({ zone, seed: 1 });

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
		const cells = buildTerraformsHypercastleSurfaceTextureCells({ zone: monoZone!, seed: 42 });
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
