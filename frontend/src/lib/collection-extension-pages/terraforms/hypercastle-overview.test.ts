import { describe, expect, it } from 'vitest';
import {
	buildTerraformsHypercastleOverviewLevelGuides,
	buildTerraformsHypercastleOverviewLayers,
	buildTerraformsHypercastleOverviewRenderKey,
	formatTerraformsHypercastleOverviewLevelGuideLabel,
	projectTerraformsHypercastleOverviewPointToScreen,
	resolveTerraformsHypercastleOverviewBounds,
	resolveTerraformsHypercastleOverviewFaceGeometry,
	resolveTerraformsHypercastleOverviewLayout,
	TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS,
	TERRAFORMS_HYPERCASTLE_OVERVIEW_RENDER_KEY_SEPARATORS
} from '$lib/collection-extension-pages/terraforms/hypercastle-overview';

const ACCEPTED_OVERVIEW_VERTICAL_STEP_UNITS = 2.88;

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

	it('keeps the accepted overview spacing while rendering very thin slabs', () => {
		const layers = buildTerraformsHypercastleOverviewLayers();
		const first = layers[0]!;
		const second = layers[1]!;
		const gap = second.baseTopUnits - first.topFaceTopUnits;
		const verticalStep = second.topFaceTopUnits - first.topFaceTopUnits;

		expect(first.layerHeightUnits).toBeLessThan(0.2);
		expect(gap).toBeGreaterThan(first.layerHeightUnits * 10);
		expect(verticalStep).toBeCloseTo(ACCEPTED_OVERVIEW_VERTICAL_STEP_UNITS, 8);
		expect(new Set(layers.map((layer) => layer.layerHeightUnits)).size).toBe(1);
	});

	it('anchors every slab face around the shared center spine', () => {
		const layer = buildTerraformsHypercastleOverviewLayers()[12]!;

		expect(
			resolveTerraformsHypercastleOverviewFaceGeometry(
				layer,
				TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS.Front
			)
		).toMatchObject({
			right: layer.halfSizeUnits,
			left: -layer.halfSizeUnits
		});
		expect(
			resolveTerraformsHypercastleOverviewFaceGeometry(
				layer,
				TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS.Side
			)
		).toMatchObject({
			right: -layer.halfSizeUnits,
			left: layer.halfSizeUnits
		});
		expect(
			resolveTerraformsHypercastleOverviewFaceGeometry(
				layer,
				TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS.Top
			)
		).toMatchObject({
			right: -layer.halfSizeUnits,
			left: -layer.halfSizeUnits
		});
	});

	it('resolves a centered responsive layout with a right-side label lane', () => {
		const layers = buildTerraformsHypercastleOverviewLayers();
		const bounds = resolveTerraformsHypercastleOverviewBounds(layers);
		const desktop = resolveTerraformsHypercastleOverviewLayout(layers, 1280);
		const mobile = resolveTerraformsHypercastleOverviewLayout(layers, 390);

		expect(bounds.minX).toBeCloseTo(-bounds.maxX, 6);
		expect(desktop.groupTopOffsetUnits).toBe(bounds.centerY);
		expect(desktop.groupRightOffsetUnits).toBeCloseTo(-desktop.groupLeftOffsetUnits, 8);
		expect(desktop.scale).toBeGreaterThan(mobile.scale);
		expect(desktop.width).toBeGreaterThan(0);
		expect(desktop.height).toBeGreaterThan(0);
	});

	it('builds one shared-cutoff level guide per slab', () => {
		const layers = buildTerraformsHypercastleOverviewLayers();
		const layout = resolveTerraformsHypercastleOverviewLayout(layers, 1280);
		const guides = buildTerraformsHypercastleOverviewLevelGuides(layers, layout);

		expect(guides).toHaveLength(20);
		expect(new Set(guides.map((guide) => guide.lineEnd.x)).size).toBe(1);
		expect(guides.every((guide) => guide.lineStart.x > guide.corner.x)).toBe(true);
		expect(guides.every((guide) => guide.labelAnchor.x > guide.lineEnd.x)).toBe(true);
		const levelOneBottomCorner = projectTerraformsHypercastleOverviewPointToScreen(
			{
				right: layers[0]!.halfSizeUnits,
				left: -layers[0]!.halfSizeUnits,
				top: layers[0]!.baseTopUnits
			},
			layout
		);
		expect(guides[0]!.corner).toEqual(levelOneBottomCorner);
		expect(guides[0]!.label).toBe(formatTerraformsHypercastleOverviewLevelGuideLabel(1));
		expect(guides[19]!.label).toBe(formatTerraformsHypercastleOverviewLevelGuideLabel(20));
	});

	it('creates a render key from stable level dimensions', () => {
		const key = buildTerraformsHypercastleOverviewRenderKey(
			buildTerraformsHypercastleOverviewLayers()
		);
		const levelKeys = key
			.split(TERRAFORMS_HYPERCASTLE_OVERVIEW_RENDER_KEY_SEPARATORS.layer)
			.map((levelKey) =>
				levelKey.split(TERRAFORMS_HYPERCASTLE_OVERVIEW_RENDER_KEY_SEPARATORS.part).map(Number)
			);

		expect(levelKeys[0]).toEqual([1, 4, 1]);
		expect(levelKeys[12]).toEqual([13, 48, 12]);
		expect(levelKeys[19]).toEqual([20, 4, 1]);
	});
});
