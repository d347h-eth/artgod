import {
	TERRAFORMS_HYPERCASTLE_LEVELS,
	TERRAFORMS_HYPERCASTLE_MAX_LEVEL_DIMENSION,
	type TerraformsLevelSummary
} from '@artgod/shared/extensions/terraforms';

type ValueOf<T> = T[keyof T];

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
	groupRightOffsetUnits: number;
	groupLeftOffsetUnits: number;
	groupTopOffsetUnits: number;
	levelGuideLineEndX: number;
	levelGuideCornerGap: number;
	levelGuideLabelGap: number;
	allLevelsLabelRowGap: number;
};

// Face literals define the renderer contract shared by geometry, Svelte, and tests.
export const TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS = {
	Front: 'front',
	Side: 'side',
	Top: 'top'
} as const;

export type TerraformsHypercastleOverviewFaceKind = ValueOf<
	typeof TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS
>;

export type TerraformsHypercastleOverviewFaceGeometry = {
	right: number;
	left: number;
	top: number;
	width: number;
	height: number;
};

export type TerraformsHypercastleOverviewPoint = {
	right: number;
	left: number;
	top: number;
};

export type TerraformsHypercastleOverviewProjectedPoint = {
	x: number;
	y: number;
};

export type TerraformsHypercastleOverviewScreenPoint = {
	x: number;
	y: number;
};

export type TerraformsHypercastleOverviewLevelGuide = {
	key: string;
	levelNumber: number;
	label: string;
	corner: TerraformsHypercastleOverviewScreenPoint;
	lineStart: TerraformsHypercastleOverviewScreenPoint;
	lineEnd: TerraformsHypercastleOverviewScreenPoint;
	labelAnchor: TerraformsHypercastleOverviewScreenPoint;
};

// DOM names are exported so tests probe the same contract the renderer writes.
export const TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM = {
	testId: 'terraforms-hypercastle-overview',
	ids: {
		levelPrefix: 'terraforms-hypercastle-level-',
		guidePrefix: 'terraforms-hypercastle-level-guide-',
		guideGroup: 'terraforms-hypercastle-overview-level-guides',
		allLevelsGuide: 'terraforms-hypercastle-overview-all-levels-guide'
	},
	classes: {
		root: 'terraforms-hypercastle-overview',
		canvas: 'terraforms-hypercastle-overview-canvas',
		status: 'terraforms-hypercastle-overview-status',
		svg: 'terraforms-hypercastle-overview-svg',
		layer: 'terraforms-hypercastle-overview-layer',
		layerHovered: 'terraforms-hypercastle-overview-layer-hovered',
		layerSelected: 'terraforms-hypercastle-overview-layer-selected',
		face: 'terraforms-hypercastle-overview-layer-face',
		textureCell: 'terraforms-hypercastle-overview-layer-texture-cell',
		guide: 'terraforms-hypercastle-overview-level-guide',
		guideHovered: 'terraforms-hypercastle-overview-level-guide-hovered',
		guideSelected: 'terraforms-hypercastle-overview-level-guide-selected',
		guideHitTarget: 'terraforms-hypercastle-overview-level-guide-hit-target',
		guideLeader: 'terraforms-hypercastle-overview-level-guide-leader',
		guideLabel: 'terraforms-hypercastle-overview-level-guide-label',
		allLevelsGuide: 'terraforms-hypercastle-overview-all-levels-guide',
		allLevelsGuideHovered: 'terraforms-hypercastle-overview-all-levels-guide-hovered',
		allLevelsGuideSelected: 'terraforms-hypercastle-overview-all-levels-guide-selected',
		allLevelsGuideHitTarget: 'terraforms-hypercastle-overview-all-levels-guide-hit-target',
		allLevelsGuideLabel: 'terraforms-hypercastle-overview-all-levels-guide-label'
	},
	attributes: {
		levelCount: 'data-level-count',
		levelNumber: 'data-level-number',
		levelDimension: 'data-level-dimension',
		surfaceKey: 'data-surface-key',
		surfaceSeed: 'data-surface-seed',
		surfaceZoneIndex: 'data-surface-zone-index',
		surfaceBackgroundColor: 'data-surface-background-color',
		surfaceTextureHeightmapIndex: 'data-surface-texture-heightmap-index',
		guideCutoffX: 'data-guide-cutoff-x'
	}
} as const;

// Renderer labels and colors are shared between the component and browser harness.
export const TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION = {
	ariaLabel: 'Hypercastle overview',
	renderError: 'isometric renderer unavailable',
	color: 'var(--c-blue)',
	canvasBackground: 'transparent',
	fillOpacity: {
		top: 0,
		vertical: 1
	},
	strokeOpacity: {
		top: 0,
		vertical: 1,
		textureCell: 0
	},
	strokeDashArray: {
		solid: [],
		dashed: [4, 3]
	},
	strokeWidth: 1,
	textureCellStrokeWidth: 0,
	levelLabelFontSize: 13,
	levelLabelHitWidth: 68,
	levelGuideHitHeight: 18,
	allLevelsLabelHitWidth: 86,
	levelGuideLineHiddenOpacity: 0,
	levelGuideLineStrokeWidth: 1,
	levelLabelTextOpacity: 0.86
} as const;

// Browser-visible style values are centralized for Playwright assertions.
export const TERRAFORMS_HYPERCASTLE_OVERVIEW_BROWSER_VALUES = {
	fillTransparent: '0',
	fillOpaque: '1',
	fillColorTransparent: 'transparent',
	pointerEventsAll: 'all',
	strokeDashArrayDashed: '4 3',
	strokeOpacityHidden: '0',
	strokeWidthSingle: '1'
} as const;

// Render-key separators keep key shape assertions aligned with the builder.
export const TERRAFORMS_HYPERCASTLE_OVERVIEW_RENDER_KEY_SEPARATORS = {
	part: ':',
	layer: '|'
} as const;

const OVERVIEW_LAYER_HEIGHT_UNITS = 0.14;
const OVERVIEW_LAYER_VERTICAL_STEP_UNITS = 2.88;
const OVERVIEW_LAYER_GAP_UNITS = OVERVIEW_LAYER_VERTICAL_STEP_UNITS - OVERVIEW_LAYER_HEIGHT_UNITS;
const OVERVIEW_MIN_LAYER_SIZE_UNITS = 1;
const OVERVIEW_MAX_LAYER_SIZE_UNITS = 12;
const OVERVIEW_CANVAS_MARGIN = 24;
const OVERVIEW_MIN_SCALE = 7;
const OVERVIEW_MAX_SCALE = 18;
const OVERVIEW_DESKTOP_SIDE_ALLOWANCE = 560;
const OVERVIEW_MOBILE_SIDE_ALLOWANCE = 32;
const OVERVIEW_MIN_AVAILABLE_WIDTH = 320;
const OVERVIEW_DESKTOP_LABEL_LANE_WIDTH = 150;
const OVERVIEW_MOBILE_LABEL_LANE_WIDTH = 118;
const OVERVIEW_DESKTOP_LABEL_LINE_LENGTH = 54;
const OVERVIEW_MOBILE_LABEL_LINE_LENGTH = 38;
const OVERVIEW_LABEL_CORNER_GAP = 8;
const OVERVIEW_LABEL_TEXT_GAP = 8;
const OVERVIEW_ALL_LEVELS_ROW_HEIGHT = 56;
const OVERVIEW_ALL_LEVELS_LABEL_ROW_GAP = 44;
const ISOMETRIC_X_FACTOR = Math.sqrt(3) / 2;
const OVERVIEW_LAYER_KEY_PREFIX = 'level-';
const OVERVIEW_GUIDE_KEY_PREFIX = 'level-guide-';
const OVERVIEW_RENDER_KEY_PART_SEPARATOR =
	TERRAFORMS_HYPERCASTLE_OVERVIEW_RENDER_KEY_SEPARATORS.part;
const OVERVIEW_RENDER_KEY_LAYER_SEPARATOR =
	TERRAFORMS_HYPERCASTLE_OVERVIEW_RENDER_KEY_SEPARATORS.layer;

export function resolveTerraformsHypercastleOverviewFaceClassName(
	face: TerraformsHypercastleOverviewFaceKind
): string {
	return `${TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.face}-${face}`;
}

export function resolveTerraformsHypercastleOverviewLayerElementId(levelNumber: number): string {
	return `${TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.ids.levelPrefix}${levelNumber}`;
}

export function resolveTerraformsHypercastleOverviewLevelGuideElementId(
	levelNumber: number
): string {
	return `${TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.ids.guidePrefix}${levelNumber}`;
}

export function formatTerraformsHypercastleOverviewLayerLabel(levelNumber: number): string {
	return `Hypercastle level ${levelNumber}`;
}

export function formatTerraformsHypercastleOverviewLevelGuideLabel(levelNumber: number): string {
	return `Level ${levelNumber}`;
}

// Build bottom-to-top slab geometry for the fixed 20-level Hypercastle.
export function buildTerraformsHypercastleOverviewLayers(
	levels: readonly TerraformsLevelSummary[] = TERRAFORMS_HYPERCASTLE_LEVELS
): TerraformsHypercastleOverviewLayer[] {
	return levels.map((level) => {
		const baseTopUnits =
			level.levelIndex * (OVERVIEW_LAYER_HEIGHT_UNITS + OVERVIEW_LAYER_GAP_UNITS);
		const sizeUnits = resolveLayerSizeUnits(level);
		return {
			key: `${OVERVIEW_LAYER_KEY_PREFIX}${level.levelNumber}`,
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
	const baseWidth = Math.ceil(bounds.width * scale + OVERVIEW_CANVAS_MARGIN * 2);
	const labelLaneWidth =
		viewportWidth > 900 ? OVERVIEW_DESKTOP_LABEL_LANE_WIDTH : OVERVIEW_MOBILE_LABEL_LANE_WIDTH;
	const labelLineLength =
		viewportWidth > 900 ? OVERVIEW_DESKTOP_LABEL_LINE_LENGTH : OVERVIEW_MOBILE_LABEL_LINE_LENGTH;
	const groupShiftX = -labelLaneWidth / 2;
	const groupRightOffsetUnits = groupShiftX / (2 * ISOMETRIC_X_FACTOR * scale);
	const groupLeftOffsetUnits = -groupRightOffsetUnits;
	const structureRightX = baseWidth - OVERVIEW_CANVAS_MARGIN;
	return {
		width: baseWidth + labelLaneWidth,
		height: Math.ceil(bounds.height * scale + OVERVIEW_CANVAS_MARGIN * 2 + OVERVIEW_ALL_LEVELS_ROW_HEIGHT),
		scale,
		groupRightOffsetUnits,
		groupLeftOffsetUnits,
		groupTopOffsetUnits: bounds.centerY,
		levelGuideLineEndX: structureRightX + OVERVIEW_LABEL_CORNER_GAP + labelLineLength,
		levelGuideCornerGap: OVERVIEW_LABEL_CORNER_GAP,
		levelGuideLabelGap: OVERVIEW_LABEL_TEXT_GAP,
		allLevelsLabelRowGap: OVERVIEW_ALL_LEVELS_LABEL_ROW_GAP
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
		.map((layer) =>
			[layer.levelNumber, layer.dimension, layer.sizeUnits].join(OVERVIEW_RENDER_KEY_PART_SEPARATOR)
		)
		.join(OVERVIEW_RENDER_KEY_LAYER_SEPARATOR);
}

export function resolveTerraformsHypercastleOverviewFaceGeometry(
	layer: TerraformsHypercastleOverviewLayer,
	face: TerraformsHypercastleOverviewFaceKind
): TerraformsHypercastleOverviewFaceGeometry {
	switch (face) {
		case TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS.Front:
			return {
				right: layer.halfSizeUnits,
				left: -layer.halfSizeUnits,
				top: layer.baseTopUnits,
				width: layer.sizeUnits,
				height: layer.layerHeightUnits
			};
		case TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS.Side:
			return {
				right: -layer.halfSizeUnits,
				left: layer.halfSizeUnits,
				top: layer.baseTopUnits,
				width: layer.sizeUnits,
				height: layer.layerHeightUnits
			};
		case TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS.Top:
			return {
				right: -layer.halfSizeUnits,
				left: -layer.halfSizeUnits,
				top: layer.topFaceTopUnits,
				width: layer.sizeUnits,
				height: layer.sizeUnits
			};
	}
}

export function isTerraformsHypercastleOverviewVerticalFace(
	face: TerraformsHypercastleOverviewFaceKind
): boolean {
	return (
		face === TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS.Front ||
		face === TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS.Side
	);
}

export function buildTerraformsHypercastleOverviewLevelGuides(
	layers: readonly TerraformsHypercastleOverviewLayer[],
	layout: TerraformsHypercastleOverviewLayout
): TerraformsHypercastleOverviewLevelGuide[] {
	return layers.map((layer) => {
		const corner = projectTerraformsHypercastleOverviewPointToScreen(
			{
				right: layer.halfSizeUnits,
				left: -layer.halfSizeUnits,
				top: layer.baseTopUnits
			},
			layout
		);
		const lineStart = {
			x: corner.x + layout.levelGuideCornerGap,
			y: corner.y
		};
		const lineEnd = {
			x: layout.levelGuideLineEndX,
			y: corner.y
		};
		return {
			key: `${OVERVIEW_GUIDE_KEY_PREFIX}${layer.levelNumber}`,
			levelNumber: layer.levelNumber,
			label: formatTerraformsHypercastleOverviewLevelGuideLabel(layer.levelNumber),
			corner,
			lineStart,
			lineEnd,
			labelAnchor: {
				x: lineEnd.x + layout.levelGuideLabelGap,
				y: corner.y
			}
		};
	});
}

export function projectTerraformsHypercastleOverviewPoint(
	point: TerraformsHypercastleOverviewPoint
): TerraformsHypercastleOverviewProjectedPoint {
	return {
		x: (point.right - point.left) * ISOMETRIC_X_FACTOR,
		y: (point.right + point.left) / 2 - point.top
	};
}

export function projectTerraformsHypercastleOverviewPointToScreen(
	point: TerraformsHypercastleOverviewPoint,
	layout: TerraformsHypercastleOverviewLayout
): TerraformsHypercastleOverviewScreenPoint {
	const projected = projectTerraformsHypercastleOverviewPoint(point);
	const groupOffset = projectTerraformsHypercastleOverviewPoint({
		right: layout.groupRightOffsetUnits,
		left: layout.groupLeftOffsetUnits,
		top: layout.groupTopOffsetUnits
	});
	return {
		x: layout.width / 2 + (projected.x + groupOffset.x) * layout.scale,
		y: layout.height / 2 + (projected.y + groupOffset.y) * layout.scale
	};
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
): TerraformsHypercastleOverviewProjectedPoint[] {
	const edges = [-layer.halfSizeUnits, layer.halfSizeUnits];
	const tops = [layer.baseTopUnits, layer.topFaceTopUnits];
	return tops.flatMap((top) =>
		edges.flatMap((right) =>
			edges.flatMap((left) =>
				projectTerraformsHypercastleOverviewPoint({
					right,
					left,
					top
				})
			)
		)
	);
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(Math.max(value, minimum), maximum);
}
