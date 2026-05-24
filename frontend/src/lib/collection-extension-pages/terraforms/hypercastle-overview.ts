import {
	TERRAFORMS_HYPERCASTLE_LEVELS,
	TERRAFORMS_HYPERCASTLE_MAX_LEVEL_DIMENSION,
	type TerraformsLevelSummary
} from '@artgod/shared/extensions/terraforms';

export type TerraformsHypercastleOverviewLayer = {
	key: string;
	levelNumber: number;
	dimension: number;
	sizeUnits: number;
	halfSizeUnits: number;
	baseTopUnits: number;
	topFaceTopUnits: number;
	layerHeightUnits: number;
};

export type TerraformsHypercastleOverviewBounds = {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
	width: number;
	height: number;
	centerY: number;
};

export type TerraformsHypercastleOverviewLayout = {
	width: number;
	height: number;
	scale: number;
	groupTopOffsetUnits: number;
};

export type TerraformsHypercastleOverviewFaceKind = 'front' | 'side' | 'top';

export type TerraformsHypercastleOverviewFaceGeometry = {
	right: number;
	left: number;
	top: number;
	width: number;
	height: number;
};

const OVERVIEW_LAYER_HEIGHT_UNITS = 0.72;
const OVERVIEW_LAYER_GAP_UNITS = OVERVIEW_LAYER_HEIGHT_UNITS * 3;
const OVERVIEW_MIN_LAYER_SIZE_UNITS = 1;
const OVERVIEW_MAX_LAYER_SIZE_UNITS = 12;
const OVERVIEW_CANVAS_MARGIN = 24;
const OVERVIEW_MIN_SCALE = 7;
const OVERVIEW_MAX_SCALE = 18;
const OVERVIEW_DESKTOP_SIDE_ALLOWANCE = 560;
const OVERVIEW_MOBILE_SIDE_ALLOWANCE = 32;
const OVERVIEW_MIN_AVAILABLE_WIDTH = 320;
const ISOMETRIC_X_FACTOR = Math.sqrt(3) / 2;

// Build bottom-to-top slab geometry for the fixed 20-level Hypercastle.
export function buildTerraformsHypercastleOverviewLayers(
	levels: readonly TerraformsLevelSummary[] = TERRAFORMS_HYPERCASTLE_LEVELS
): TerraformsHypercastleOverviewLayer[] {
	return levels.map((level) => {
		const baseTopUnits = level.levelIndex * (OVERVIEW_LAYER_HEIGHT_UNITS + OVERVIEW_LAYER_GAP_UNITS);
		const sizeUnits = resolveLayerSizeUnits(level);
		return {
			key: `level-${level.levelNumber}`,
			levelNumber: level.levelNumber,
			dimension: level.dimension,
			sizeUnits,
			halfSizeUnits: sizeUnits / 2,
			baseTopUnits,
			topFaceTopUnits: baseTopUnits + OVERVIEW_LAYER_HEIGHT_UNITS,
			layerHeightUnits: OVERVIEW_LAYER_HEIGHT_UNITS
		};
	});
}

// Resolve responsive SVG layout while keeping the center spine fixed.
export function resolveTerraformsHypercastleOverviewLayout(
	layers: readonly TerraformsHypercastleOverviewLayer[],
	viewportWidth: number
): TerraformsHypercastleOverviewLayout {
	const bounds = resolveTerraformsHypercastleOverviewBounds(layers);
	const sideAllowance =
		viewportWidth > 900 ? OVERVIEW_DESKTOP_SIDE_ALLOWANCE : OVERVIEW_MOBILE_SIDE_ALLOWANCE;
	const availableCanvasWidth = Math.max(
		viewportWidth - sideAllowance,
		OVERVIEW_MIN_AVAILABLE_WIDTH
	);
	const scale = clamp(
		Math.floor((availableCanvasWidth - OVERVIEW_CANVAS_MARGIN * 2) / bounds.width),
		OVERVIEW_MIN_SCALE,
		OVERVIEW_MAX_SCALE
	);
	return {
		width: Math.ceil(bounds.width * scale + OVERVIEW_CANVAS_MARGIN * 2),
		height: Math.ceil(bounds.height * scale + OVERVIEW_CANVAS_MARGIN * 2),
		scale,
		groupTopOffsetUnits: bounds.centerY
	};
}

export function resolveTerraformsHypercastleOverviewBounds(
	layers: readonly TerraformsHypercastleOverviewLayer[]
): TerraformsHypercastleOverviewBounds {
	const points = layers.flatMap(resolveLayerProjectedPoints);
	const minX = Math.min(...points.map((point) => point.x));
	const maxX = Math.max(...points.map((point) => point.x));
	const minY = Math.min(...points.map((point) => point.y));
	const maxY = Math.max(...points.map((point) => point.y));
	return {
		minX,
		maxX,
		minY,
		maxY,
		width: maxX - minX,
		height: maxY - minY,
		centerY: (minY + maxY) / 2
	};
}

export function buildTerraformsHypercastleOverviewRenderKey(
	layers: readonly TerraformsHypercastleOverviewLayer[]
): string {
	return layers
		.map((layer) => [layer.levelNumber, layer.dimension, layer.sizeUnits].join(':'))
		.join('|');
}

export function resolveTerraformsHypercastleOverviewFaceGeometry(
	layer: TerraformsHypercastleOverviewLayer,
	face: TerraformsHypercastleOverviewFaceKind
): TerraformsHypercastleOverviewFaceGeometry {
	switch (face) {
		case 'front':
			return {
				right: layer.halfSizeUnits,
				left: -layer.halfSizeUnits,
				top: layer.baseTopUnits,
				width: layer.sizeUnits,
				height: layer.layerHeightUnits
			};
		case 'side':
			return {
				right: -layer.halfSizeUnits,
				left: layer.halfSizeUnits,
				top: layer.baseTopUnits,
				width: layer.sizeUnits,
				height: layer.layerHeightUnits
			};
		case 'top':
			return {
				right: -layer.halfSizeUnits,
				left: -layer.halfSizeUnits,
				top: layer.topFaceTopUnits,
				width: layer.sizeUnits,
				height: layer.sizeUnits
			};
	}
}

function resolveLayerSizeUnits(level: TerraformsLevelSummary): number {
	return clamp(
		(level.dimension / TERRAFORMS_HYPERCASTLE_MAX_LEVEL_DIMENSION) * OVERVIEW_MAX_LAYER_SIZE_UNITS,
		OVERVIEW_MIN_LAYER_SIZE_UNITS,
		OVERVIEW_MAX_LAYER_SIZE_UNITS
	);
}

function resolveLayerProjectedPoints(
	layer: TerraformsHypercastleOverviewLayer
): Array<{ x: number; y: number }> {
	const edges = [-layer.halfSizeUnits, layer.halfSizeUnits];
	const topValues = [layer.baseTopUnits, layer.topFaceTopUnits];
	return edges.flatMap((right) =>
		edges.flatMap((left) =>
			topValues.map((top) => ({
				x: (right - left) * ISOMETRIC_X_FACTOR,
				y: (right + left) / 2 - top
			}))
		)
	);
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(Math.max(value, minimum), maximum);
}
