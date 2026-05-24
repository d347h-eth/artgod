import { describe, expect, it } from 'vitest';
import {
	buildTerraformsHypercastleOverviewOutlineSegments,
	buildTerraformsHypercastleOverviewLayers,
	buildTerraformsHypercastleOverviewRenderKey,
	resolveTerraformsHypercastleOverviewBounds,
	resolveTerraformsHypercastleOverviewFaceGeometry,
	resolveTerraformsHypercastleOverviewLayout,
	TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS,
	TERRAFORMS_HYPERCASTLE_OVERVIEW_OUTLINE_POSITIONS,
	TERRAFORMS_HYPERCASTLE_OVERVIEW_OUTLINE_STYLES,
	TERRAFORMS_HYPERCASTLE_OVERVIEW_RENDER_KEY_SEPARATORS
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

	it('keeps gaps at triple the slab height for the overview pass', () => {
		const layers = buildTerraformsHypercastleOverviewLayers();
		const first = layers[0]!;
		const second = layers[1]!;
		const gap = second.baseTopUnits - first.topFaceTopUnits;

		expect(gap).toBeCloseTo(first.layerHeightUnits * 3, 8);
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

	it('marks rear slab outlines as solid until an upper slab hides them', () => {
		const layers = buildTerraformsHypercastleOverviewLayers();
		const segments = buildTerraformsHypercastleOverviewOutlineSegments(layers);
		const topBackSegments = segments.filter(
			(segment) => segment.position === TERRAFORMS_HYPERCASTLE_OVERVIEW_OUTLINE_POSITIONS.TopBack
		);
		const topLayerSegments = topBackSegments.filter((segment) => segment.levelNumber === 20);
		const levelTwelveSegments = topBackSegments.filter((segment) => segment.levelNumber === 12);

		expect(
			topBackSegments.some(
				(segment) => segment.style === TERRAFORMS_HYPERCASTLE_OVERVIEW_OUTLINE_STYLES.Solid
			)
		).toBe(true);
		expect(
			topBackSegments.some(
				(segment) => segment.style === TERRAFORMS_HYPERCASTLE_OVERVIEW_OUTLINE_STYLES.Dashed
			)
		).toBe(true);
		expect(topLayerSegments).toHaveLength(2);
		expect(
			topLayerSegments.every(
				(segment) => segment.style === TERRAFORMS_HYPERCASTLE_OVERVIEW_OUTLINE_STYLES.Solid
			)
		).toBe(true);
		expect(
			levelTwelveSegments.some(
				(segment) => segment.style === TERRAFORMS_HYPERCASTLE_OVERVIEW_OUTLINE_STYLES.Dashed
			)
		).toBe(true);
		expect(new Set(segments.map((segment) => segment.key)).size).toBe(segments.length);
	});

	it('adds dashed lower rear outlines for every slab', () => {
		const segments = buildTerraformsHypercastleOverviewOutlineSegments(
			buildTerraformsHypercastleOverviewLayers()
		);
		const bottomBackSegments = segments.filter(
			(segment) => segment.position === TERRAFORMS_HYPERCASTLE_OVERVIEW_OUTLINE_POSITIONS.BottomBack
		);

		expect(bottomBackSegments).toHaveLength(40);
		expect(
			bottomBackSegments.every(
				(segment) => segment.style === TERRAFORMS_HYPERCASTLE_OVERVIEW_OUTLINE_STYLES.Dashed
			)
		).toBe(true);
		expect(new Set(bottomBackSegments.map((segment) => segment.levelNumber)).size).toBe(20);
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
