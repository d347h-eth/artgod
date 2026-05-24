import { describe, expect, it } from 'vitest';
import {
	buildTerraformsHypercastleOverviewLayers,
	buildTerraformsHypercastleOverviewRenderKey,
	resolveTerraformsHypercastleOverviewBounds,
	resolveTerraformsHypercastleOverviewFaceGeometry,
	resolveTerraformsHypercastleOverviewLayout
} from '$lib/collection-extension-pages/terraforms/hypercastle-overview';

describe('Terraforms Hypercastle overview geometry', () => {
	it('builds one centered slab per contract level', () => {
		const layers = buildTerraformsHypercastleOverviewLayers();

		expect(layers).toHaveLength(20);
		expect(layers.map((layer) => layer.levelNumber)).toEqual([
			1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20
		]);
		expect(layers.every((layer) => layer.halfSizeUnits === layer.sizeUnits / 2)).toBe(true);
	});

	it('sizes square slabs by contract grid area', () => {
		const layers = buildTerraformsHypercastleOverviewLayers();
		const levelOne = layers[0]!;
		const levelThirteen = layers[12]!;
		const levelTwenty = layers[19]!;

		expect(levelThirteen.sizeUnits / levelOne.sizeUnits).toBe(12);
		expect(levelThirteen.sizeUnits ** 2 / levelOne.sizeUnits ** 2).toBe(144);
		expect(levelTwenty.sizeUnits).toBe(levelOne.sizeUnits);
	});

	it('keeps gaps at twice the slab height for the overview pass', () => {
		const layers = buildTerraformsHypercastleOverviewLayers();
		const first = layers[0]!;
		const second = layers[1]!;
		const gap = second.baseTopUnits - first.topFaceTopUnits;

		expect(gap).toBeCloseTo(first.layerHeightUnits * 2, 8);
		expect(new Set(layers.map((layer) => layer.layerHeightUnits)).size).toBe(1);
	});

	it('anchors every slab face around the shared center spine', () => {
		const layer = buildTerraformsHypercastleOverviewLayers()[12]!;

		expect(resolveTerraformsHypercastleOverviewFaceGeometry(layer, 'front')).toMatchObject({
			right: layer.halfSizeUnits,
			left: -layer.halfSizeUnits
		});
		expect(resolveTerraformsHypercastleOverviewFaceGeometry(layer, 'side')).toMatchObject({
			right: -layer.halfSizeUnits,
			left: layer.halfSizeUnits
		});
		expect(resolveTerraformsHypercastleOverviewFaceGeometry(layer, 'top')).toMatchObject({
			right: -layer.halfSizeUnits,
			left: -layer.halfSizeUnits
		});
	});

	it('resolves a centered responsive layout for the shared spine', () => {
		const layers = buildTerraformsHypercastleOverviewLayers();
		const bounds = resolveTerraformsHypercastleOverviewBounds(layers);
		const desktop = resolveTerraformsHypercastleOverviewLayout(layers, 1280);
		const mobile = resolveTerraformsHypercastleOverviewLayout(layers, 390);

		expect(bounds.minX).toBeCloseTo(-bounds.maxX, 6);
		expect(desktop.groupTopOffsetUnits).toBe(bounds.centerY);
		expect(desktop.scale).toBeGreaterThan(mobile.scale);
		expect(desktop.width).toBeGreaterThan(0);
		expect(desktop.height).toBeGreaterThan(0);
	});

	it('creates a render key from stable level dimensions', () => {
		const key = buildTerraformsHypercastleOverviewRenderKey(
			buildTerraformsHypercastleOverviewLayers()
		);

		expect(key).toContain('1:4:1');
		expect(key).toContain('13:48:12');
		expect(key).toContain('20:4:1');
	});
});
