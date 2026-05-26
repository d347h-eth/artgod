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

// Hidden-line style literals define how rear outlines are painted.
export const TERRAFORMS_HYPERCASTLE_OVERVIEW_OUTLINE_STYLES = {
	Solid: 'solid',
	Dotted: 'dotted'
} as const;

export type TerraformsHypercastleOverviewOutlineStyle = ValueOf<
	typeof TERRAFORMS_HYPERCASTLE_OVERVIEW_OUTLINE_STYLES
>;

// Hidden-line position literals distinguish top rear edges from lower rear edges.
export const TERRAFORMS_HYPERCASTLE_OVERVIEW_OUTLINE_POSITIONS = {
	TopBack: 'top-back',
	BottomBack: 'bottom-back'
} as const;

export type TerraformsHypercastleOverviewOutlinePosition = ValueOf<
	typeof TERRAFORMS_HYPERCASTLE_OVERVIEW_OUTLINE_POSITIONS
>;

// Hidden-line edge literals identify each rear edge of a square slab.
export const TERRAFORMS_HYPERCASTLE_OVERVIEW_OUTLINE_EDGES = {
	Left: 'left',
	Right: 'right'
} as const;

export type TerraformsHypercastleOverviewOutlineEdge = ValueOf<
	typeof TERRAFORMS_HYPERCASTLE_OVERVIEW_OUTLINE_EDGES
>;

export type TerraformsHypercastleOverviewOutlineSegment = {
	key: string;
	levelNumber: number;
	position: TerraformsHypercastleOverviewOutlinePosition;
	edge: TerraformsHypercastleOverviewOutlineEdge;
	style: TerraformsHypercastleOverviewOutlineStyle;
	start: TerraformsHypercastleOverviewPoint;
	end: TerraformsHypercastleOverviewPoint;
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
		outlineGroup: 'terraforms-hypercastle-overview-back-outlines',
		guideGroup: 'terraforms-hypercastle-overview-level-guides',
		allLevelsGuide: 'terraforms-hypercastle-overview-all-levels-guide',
		stripePattern: 'terraforms-hypercastle-overview-level-12-stripes'
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
		faceFaded: 'terraforms-hypercastle-overview-layer-face-faded',
		outlineSegment: 'terraforms-hypercastle-overview-outline-segment',
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
		surfaceSeed: 'data-surface-seed',
		outlinePosition: 'data-outline-position',
		outlineStyle: 'data-outline-style',
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
		visible: 1
	},
	strokeDashArray: {
		solid: [],
		dashed: [4, 3],
		dotted: [1, 4]
	},
	strokeWidth: 1,
	fadedLevelNumber: 12,
	fadedLevelPatternFillOpacity: 0.5,
	fadedLevelPatternSize: 8,
	fadedLevelPatternStripeWidth: 4,
	fadedLevelPatternRotation: 45,
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
	pointerEventsAll: 'all',
	pointerEventsNone: 'none',
	strokeDashArraySolid: '',
	strokeDashArrayDashed: '4 3',
	strokeDashArrayDotted: '1 4',
	strokeLinecapRound: 'round',
	strokeOpacityHidden: '0',
	strokeWidthSingle: '1',
	stripePatternFill: `url(#${TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.ids.stripePattern})`
} as const;

// Render-key separators keep key shape assertions aligned with the builder.
export const TERRAFORMS_HYPERCASTLE_OVERVIEW_RENDER_KEY_SEPARATORS = {
	part: ':',
	layer: '|'
} as const;

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
const OVERVIEW_OUTLINE_KEY_PREFIX = 'level';
const OVERVIEW_GUIDE_KEY_PREFIX = 'level-guide-';
const OVERVIEW_RENDER_KEY_PART_SEPARATOR =
	TERRAFORMS_HYPERCASTLE_OVERVIEW_RENDER_KEY_SEPARATORS.part;
const OVERVIEW_RENDER_KEY_LAYER_SEPARATOR =
	TERRAFORMS_HYPERCASTLE_OVERVIEW_RENDER_KEY_SEPARATORS.layer;
const PROJECTED_POINT_KEY_SEPARATOR = ':';
const OUTLINE_KEY_SEPARATOR = '-';

export function resolveTerraformsHypercastleOverviewFaceClassName(
	face: TerraformsHypercastleOverviewFaceKind
): string {
	return `${TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.face}-${face}`;
}

export function resolveTerraformsHypercastleOverviewOutlineStyleClassName(
	style: TerraformsHypercastleOverviewOutlineStyle
): string {
	return `${TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.outlineSegment}-${style}`;
}

export function resolveTerraformsHypercastleOverviewOutlinePositionClassName(
	position: TerraformsHypercastleOverviewOutlinePosition
): string {
	return `${TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.outlineSegment}-${position}`;
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

export function buildTerraformsHypercastleOverviewOutlineSegments(
	layers: readonly TerraformsHypercastleOverviewLayer[]
): TerraformsHypercastleOverviewOutlineSegment[] {
	return layers.flatMap((layer, layerIndex) => {
		const upperLayers = layers.slice(layerIndex + 1);
		return [
			...resolveTopBackOutlineSegments(layer, upperLayers),
			...resolveBottomBackOutlineSegments(layer)
		];
	});
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

export function isTerraformsHypercastleOverviewFadedFace(
	layer: TerraformsHypercastleOverviewLayer,
	face: TerraformsHypercastleOverviewFaceKind
): boolean {
	return (
		layer.levelNumber === TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.fadedLevelNumber &&
		isTerraformsHypercastleOverviewVerticalFace(face)
	);
}

export function isTerraformsHypercastleOverviewVerticalFace(
	face: TerraformsHypercastleOverviewFaceKind
): boolean {
	return (
		face === TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS.Front ||
		face === TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS.Side
	);
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
	const topValues = [layer.baseTopUnits, layer.topFaceTopUnits];
	return edges.flatMap((right) =>
		edges.flatMap((left) =>
			topValues.map((top) =>
				projectTerraformsHypercastleOverviewPoint({
					right,
					left,
					top
				})
			)
		)
	);
}

function resolveTopBackOutlineSegments(
	layer: TerraformsHypercastleOverviewLayer,
	upperLayers: readonly TerraformsHypercastleOverviewLayer[]
): TerraformsHypercastleOverviewOutlineSegment[] {
	return resolveBackOutlineEdges(
		layer,
		TERRAFORMS_HYPERCASTLE_OVERVIEW_OUTLINE_POSITIONS.TopBack,
		layer.topFaceTopUnits
	).flatMap((outline) =>
		splitOutlineByHiddenIntervals(outline, resolveHiddenIntervals(outline, upperLayers))
	);
}

function resolveBottomBackOutlineSegments(
	layer: TerraformsHypercastleOverviewLayer
): TerraformsHypercastleOverviewOutlineSegment[] {
	return resolveBackOutlineEdges(
		layer,
		TERRAFORMS_HYPERCASTLE_OVERVIEW_OUTLINE_POSITIONS.BottomBack,
		layer.baseTopUnits
	).map((outline) => ({
		...outline,
		key: outlineKey(outline, 0),
		style: TERRAFORMS_HYPERCASTLE_OVERVIEW_OUTLINE_STYLES.Dotted
	}));
}

function resolveBackOutlineEdges(
	layer: TerraformsHypercastleOverviewLayer,
	position: TerraformsHypercastleOverviewOutlinePosition,
	top: number
): Array<Omit<TerraformsHypercastleOverviewOutlineSegment, 'key' | 'style'>> {
	const half = layer.halfSizeUnits;
	return [
		{
			levelNumber: layer.levelNumber,
			position,
			edge: TERRAFORMS_HYPERCASTLE_OVERVIEW_OUTLINE_EDGES.Left,
			start: { right: -half, left: -half, top },
			end: { right: -half, left: half, top }
		},
		{
			levelNumber: layer.levelNumber,
			position,
			edge: TERRAFORMS_HYPERCASTLE_OVERVIEW_OUTLINE_EDGES.Right,
			start: { right: -half, left: -half, top },
			end: { right: half, left: -half, top }
		}
	];
}

function resolveHiddenIntervals(
	outline: Omit<TerraformsHypercastleOverviewOutlineSegment, 'key' | 'style'>,
	upperLayers: readonly TerraformsHypercastleOverviewLayer[]
): Array<{ start: number; end: number }> {
	const start = projectTerraformsHypercastleOverviewPoint(outline.start);
	const end = projectTerraformsHypercastleOverviewPoint(outline.end);
	return mergeIntervals(
		upperLayers.flatMap((layer) =>
			resolveSegmentPolygonIntervals(start, end, convexHull(resolveLayerProjectedPoints(layer)))
		)
	);
}

function splitOutlineByHiddenIntervals(
	outline: Omit<TerraformsHypercastleOverviewOutlineSegment, 'key' | 'style'>,
	hiddenIntervals: readonly { start: number; end: number }[]
): TerraformsHypercastleOverviewOutlineSegment[] {
	const tValues = [0, 1, ...hiddenIntervals.flatMap((interval) => [interval.start, interval.end])]
		.map(normalizeT)
		.filter((value, index, values) => values.indexOf(value) === index)
		.sort((left, right) => left - right);

	return tValues
		.slice(0, -1)
		.map((startT, index) => {
			const endT = tValues[index + 1]!;
			const midpoint = (startT + endT) / 2;
			const style: TerraformsHypercastleOverviewOutlineStyle = intervalContains(
				hiddenIntervals,
				midpoint
			)
				? TERRAFORMS_HYPERCASTLE_OVERVIEW_OUTLINE_STYLES.Dotted
				: TERRAFORMS_HYPERCASTLE_OVERVIEW_OUTLINE_STYLES.Solid;
			return {
				...outline,
				key: outlineKey(outline, index),
				style,
				start: interpolatePoint(outline.start, outline.end, startT),
				end: interpolatePoint(outline.start, outline.end, endT)
			};
		})
		.filter((segment) => segmentLength(segment.start, segment.end) > 0.0001);
}

function resolveSegmentPolygonIntervals(
	start: TerraformsHypercastleOverviewProjectedPoint,
	end: TerraformsHypercastleOverviewProjectedPoint,
	polygon: readonly TerraformsHypercastleOverviewProjectedPoint[]
): Array<{ start: number; end: number }> {
	const tValues = [0, 1];
	for (let index = 0; index < polygon.length; index += 1) {
		const current = polygon[index]!;
		const next = polygon[(index + 1) % polygon.length]!;
		const intersection = segmentIntersectionT(start, end, current, next);
		if (intersection !== null) {
			tValues.push(intersection);
		}
	}
	const sorted = Array.from(new Set(tValues.map(normalizeT))).sort((left, right) => left - right);
	return sorted.slice(0, -1).flatMap((startT, index) => {
		const endT = sorted[index + 1]!;
		const midpoint = projectedPointAt(start, end, (startT + endT) / 2);
		return pointInPolygon(midpoint, polygon) ? [{ start: startT, end: endT }] : [];
	});
}

function convexHull(
	points: readonly TerraformsHypercastleOverviewProjectedPoint[]
): TerraformsHypercastleOverviewProjectedPoint[] {
	const sorted = Array.from(
		new Map(
			points.map((point) => [
				`${point.x.toFixed(8)}${PROJECTED_POINT_KEY_SEPARATOR}${point.y.toFixed(8)}`,
				point
			])
		).values()
	).sort((left, right) => left.x - right.x || left.y - right.y);
	if (sorted.length <= 1) return sorted;
	const lower: TerraformsHypercastleOverviewProjectedPoint[] = [];
	for (const point of sorted) {
		while (
			lower.length >= 2 &&
			cross(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0
		) {
			lower.pop();
		}
		lower.push(point);
	}
	const upper: TerraformsHypercastleOverviewProjectedPoint[] = [];
	for (const point of [...sorted].reverse()) {
		while (
			upper.length >= 2 &&
			cross(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0
		) {
			upper.pop();
		}
		upper.push(point);
	}
	return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function mergeIntervals(
	intervals: readonly { start: number; end: number }[]
): Array<{ start: number; end: number }> {
	const sorted = intervals
		.map((interval) => ({
			start: normalizeT(Math.min(interval.start, interval.end)),
			end: normalizeT(Math.max(interval.start, interval.end))
		}))
		.filter((interval) => interval.end - interval.start > 0.0001)
		.sort((left, right) => left.start - right.start || left.end - right.end);
	const merged: Array<{ start: number; end: number }> = [];
	for (const interval of sorted) {
		const previous = merged[merged.length - 1];
		if (!previous || interval.start > previous.end + 0.0001) {
			merged.push({ ...interval });
		} else {
			previous.end = Math.max(previous.end, interval.end);
		}
	}
	return merged;
}

function segmentIntersectionT(
	start: TerraformsHypercastleOverviewProjectedPoint,
	end: TerraformsHypercastleOverviewProjectedPoint,
	otherStart: TerraformsHypercastleOverviewProjectedPoint,
	otherEnd: TerraformsHypercastleOverviewProjectedPoint
): number | null {
	const segment = subtract(end, start);
	const otherSegment = subtract(otherEnd, otherStart);
	const denominator = cross2D(segment, otherSegment);
	if (Math.abs(denominator) < 0.000001) return null;
	const offset = subtract(otherStart, start);
	const t = cross2D(offset, otherSegment) / denominator;
	const u = cross2D(offset, segment) / denominator;
	if (t < -0.000001 || t > 1.000001 || u < -0.000001 || u > 1.000001) return null;
	return normalizeT(t);
}

function pointInPolygon(
	point: TerraformsHypercastleOverviewProjectedPoint,
	polygon: readonly TerraformsHypercastleOverviewProjectedPoint[]
): boolean {
	let inside = false;
	for (
		let index = 0, previousIndex = polygon.length - 1;
		index < polygon.length;
		previousIndex = index++
	) {
		const current = polygon[index]!;
		const previous = polygon[previousIndex]!;
		if (pointOnSegment(point, previous, current)) return true;
		const intersects =
			current.y > point.y !== previous.y > point.y &&
			point.x <
				((previous.x - current.x) * (point.y - current.y)) / (previous.y - current.y) + current.x;
		if (intersects) inside = !inside;
	}
	return inside;
}

function pointOnSegment(
	point: TerraformsHypercastleOverviewProjectedPoint,
	start: TerraformsHypercastleOverviewProjectedPoint,
	end: TerraformsHypercastleOverviewProjectedPoint
): boolean {
	return (
		Math.abs(cross(start, end, point)) < 0.000001 &&
		point.x >= Math.min(start.x, end.x) - 0.000001 &&
		point.x <= Math.max(start.x, end.x) + 0.000001 &&
		point.y >= Math.min(start.y, end.y) - 0.000001 &&
		point.y <= Math.max(start.y, end.y) + 0.000001
	);
}

function intervalContains(
	intervals: readonly { start: number; end: number }[],
	t: number
): boolean {
	return intervals.some(
		(interval) => t >= interval.start - 0.000001 && t <= interval.end + 0.000001
	);
}

function projectedPointAt(
	start: TerraformsHypercastleOverviewProjectedPoint,
	end: TerraformsHypercastleOverviewProjectedPoint,
	t: number
): TerraformsHypercastleOverviewProjectedPoint {
	return {
		x: start.x + (end.x - start.x) * t,
		y: start.y + (end.y - start.y) * t
	};
}

function interpolatePoint(
	start: TerraformsHypercastleOverviewPoint,
	end: TerraformsHypercastleOverviewPoint,
	t: number
): TerraformsHypercastleOverviewPoint {
	return {
		right: start.right + (end.right - start.right) * t,
		left: start.left + (end.left - start.left) * t,
		top: start.top + (end.top - start.top) * t
	};
}

function segmentLength(
	start: TerraformsHypercastleOverviewPoint,
	end: TerraformsHypercastleOverviewPoint
): number {
	return (
		Math.abs(end.right - start.right) +
		Math.abs(end.left - start.left) +
		Math.abs(end.top - start.top)
	);
}

function subtract(
	left: TerraformsHypercastleOverviewProjectedPoint,
	right: TerraformsHypercastleOverviewProjectedPoint
): TerraformsHypercastleOverviewProjectedPoint {
	return {
		x: left.x - right.x,
		y: left.y - right.y
	};
}

function cross(
	origin: TerraformsHypercastleOverviewProjectedPoint,
	left: TerraformsHypercastleOverviewProjectedPoint,
	right: TerraformsHypercastleOverviewProjectedPoint
): number {
	return cross2D(subtract(left, origin), subtract(right, origin));
}

function cross2D(
	left: TerraformsHypercastleOverviewProjectedPoint,
	right: TerraformsHypercastleOverviewProjectedPoint
): number {
	return left.x * right.y - left.y * right.x;
}

function normalizeT(value: number): number {
	return clamp(Number(value.toFixed(8)), 0, 1);
}

function outlineKey(
	outline: Omit<TerraformsHypercastleOverviewOutlineSegment, 'key' | 'style'>,
	index: number
): string {
	return [
		OVERVIEW_OUTLINE_KEY_PREFIX,
		outline.levelNumber,
		outline.position,
		outline.edge,
		index
	].join(OUTLINE_KEY_SEPARATOR);
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(Math.max(value, minimum), maximum);
}
