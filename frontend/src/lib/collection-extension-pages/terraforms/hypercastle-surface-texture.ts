import {
	resolveTerraformsTopographyBucket,
	TERRAFORMS_HYPERCASTLE_LEVELS,
	TERRAFORMS_ZONES,
	type TerraformsLevelSummary,
	type TerraformsZone
} from '@artgod/shared/extensions/terraforms';

export type TerraformsHypercastleSurfaceTextureCell = {
	x: number;
	y: number;
	size: number;
	color: string;
	heightmapIndex: number;
	terrainValue: number;
};

// Temporary single-level texture experiment: Level 14 rendered with the Holo palette.
export const TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_EXPERIMENT = {
	levelNumber: 14,
	zoneIndex: 17
} as const;

// DOM hooks for the experimental texture and its reroll control.
export const TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_DOM = {
	ids: {
		pattern: 'terraforms-hypercastle-level-14-holo-surface'
	},
	testIds: {
		rerollButton: 'terraforms-hypercastle-surface-reroll'
	},
	classes: {
		controls: 'terraforms-hypercastle-surface-controls',
		rerollButton: 'terraforms-hypercastle-surface-reroll'
	}
} as const;

// Compact control labels owned by the Terraforms Hypercastle texture experiment.
export const TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_LABELS = {
	RerollSurface: 'reroll surface'
} as const;

// SVG pattern values make one generated texture cover the whole isometric face once.
export const TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_PATTERN = {
	width: 1,
	height: 1,
	cellOpacity: 1,
	cellOverlap: 0.00002
} as const;

// Terraforms parcels render a 32 by 32 local heightmap, independent of level size.
export const TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_GRID_SIZE = 32;

const TERRAFORMS_HYPERCASTLE_SURFACE_NOISE = {
	octaves: 2,
	baseFrequency: 2.45,
	lacunarity: 2,
	persistence: 0.45,
	terrainValueScale: 135000,
	contrast: 1.2,
	cellCenterOffset: 0.5,
	hashX: 374761393,
	hashY: 668265263,
	hashSeed: 2147483647,
	hashShift: 13,
	hashFinal: 1274126177,
	hashUnitDivisor: 4294967295
} as const;

const TERRAFORMS_HYPERCASTLE_SURFACE_GRADIENTS = [
	[1, 0],
	[-1, 0],
	[0, 1],
	[0, -1],
	[1, 1],
	[-1, 1],
	[1, -1],
	[-1, -1]
] as const;

const TERRAFORMS_HYPERCASTLE_SURFACE_GRADIENT_NORMALIZER = Math.SQRT1_2;
const TERRAFORMS_HYPERCASTLE_SURFACE_MINIMUM_NOISE = -1;
const TERRAFORMS_HYPERCASTLE_SURFACE_MAXIMUM_NOISE = 1;
const TERRAFORMS_HYPERCASTLE_SURFACE_PATTERN_FILL_PREFIX = 'url(#';
const TERRAFORMS_HYPERCASTLE_SURFACE_PATTERN_FILL_SUFFIX = ')';

// Identifies the temporary texture target level.
export function isTerraformsHypercastleSurfaceTextureLevel(levelNumber: number): boolean {
	return levelNumber === TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_EXPERIMENT.levelNumber;
}

// Resolves the contract level used by the temporary texture experiment.
export function resolveTerraformsHypercastleSurfaceTextureLevel(): TerraformsLevelSummary {
	return TERRAFORMS_HYPERCASTLE_LEVELS[
		TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_EXPERIMENT.levelNumber - 1
	]!;
}

// Resolves the Holo Zone used by the temporary texture experiment.
export function resolveTerraformsHypercastleSurfaceTextureZone(): TerraformsZone {
	return TERRAFORMS_ZONES[TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_EXPERIMENT.zoneIndex]!;
}

// The final palette color is the canonical Terraforms background fill.
export function resolveTerraformsHypercastleSurfaceTextureBackgroundColor(): string {
	const palette = resolveTerraformsHypercastleSurfaceTextureZone().palette;
	return palette[palette.length - 1]!;
}

// Builds the SVG fill value for the generated texture pattern.
export function resolveTerraformsHypercastleSurfaceTexturePatternFill(): string {
	return [
		TERRAFORMS_HYPERCASTLE_SURFACE_PATTERN_FILL_PREFIX,
		TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_DOM.ids.pattern,
		TERRAFORMS_HYPERCASTLE_SURFACE_PATTERN_FILL_SUFFIX
	].join('');
}

// Generates a parcel-local Perlin heightmap and stretches it over the slab top face.
export function buildTerraformsHypercastleSurfaceTextureCells(input: {
	zone?: TerraformsZone;
	seed: number;
}): TerraformsHypercastleSurfaceTextureCell[] {
	const zone = input.zone ?? resolveTerraformsHypercastleSurfaceTextureZone();
	const cellSize = 1 / TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_GRID_SIZE;
	const cells: TerraformsHypercastleSurfaceTextureCell[] = [];
	for (let row = 0; row < TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_GRID_SIZE; row += 1) {
		for (let column = 0; column < TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_GRID_SIZE; column += 1) {
			const terrainValue = resolveTerraformsHypercastleSurfaceTerrainValue({
				column,
				row,
				seed: input.seed
			});
			const heightmapIndex = resolveTerraformsTopographyBucket(terrainValue);
			cells.push({
				x: column * cellSize,
				y: row * cellSize,
				size: cellSize + TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_PATTERN.cellOverlap,
				color: zone.palette[heightmapIndex]!,
				heightmapIndex,
				terrainValue
			});
		}
	}
	return cells;
}

function resolveTerraformsHypercastleSurfaceTerrainValue(input: {
	column: number;
	row: number;
	seed: number;
}): number {
	const normalizedNoise = clampNoise(
		sampleFractalPerlinNoise({
			x:
				((input.column + TERRAFORMS_HYPERCASTLE_SURFACE_NOISE.cellCenterOffset) /
					TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_GRID_SIZE) *
				TERRAFORMS_HYPERCASTLE_SURFACE_NOISE.baseFrequency,
			y:
				((input.row + TERRAFORMS_HYPERCASTLE_SURFACE_NOISE.cellCenterOffset) /
					TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_GRID_SIZE) *
				TERRAFORMS_HYPERCASTLE_SURFACE_NOISE.baseFrequency,
			seed: input.seed
		}) * TERRAFORMS_HYPERCASTLE_SURFACE_NOISE.contrast
	);
	return Math.round(
		normalizedNoise * TERRAFORMS_HYPERCASTLE_SURFACE_NOISE.terrainValueScale
	);
}

function sampleFractalPerlinNoise(input: { x: number; y: number; seed: number }): number {
	let amplitude = 1;
	let frequency = 1;
	let total = 0;
	let amplitudeTotal = 0;
	for (let octave = 0; octave < TERRAFORMS_HYPERCASTLE_SURFACE_NOISE.octaves; octave += 1) {
		total +=
			samplePerlinNoise(input.x * frequency, input.y * frequency, input.seed + octave) *
			amplitude;
		amplitudeTotal += amplitude;
		amplitude *= TERRAFORMS_HYPERCASTLE_SURFACE_NOISE.persistence;
		frequency *= TERRAFORMS_HYPERCASTLE_SURFACE_NOISE.lacunarity;
	}
	return amplitudeTotal === 0 ? 0 : total / amplitudeTotal;
}

function samplePerlinNoise(x: number, y: number, seed: number): number {
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const x1 = x0 + 1;
	const y1 = y0 + 1;
	const sx = fade(x - x0);
	const sy = fade(y - y0);
	const top = lerp(
		resolveGradientDotProduct(x0, y0, x, y, seed),
		resolveGradientDotProduct(x1, y0, x, y, seed),
		sx
	);
	const bottom = lerp(
		resolveGradientDotProduct(x0, y1, x, y, seed),
		resolveGradientDotProduct(x1, y1, x, y, seed),
		sx
	);
	return lerp(top, bottom, sy);
}

function resolveGradientDotProduct(
	gridX: number,
	gridY: number,
	x: number,
	y: number,
	seed: number
): number {
	const gradient = resolveGradient(gridX, gridY, seed);
	return gradient.x * (x - gridX) + gradient.y * (y - gridY);
}

function resolveGradient(
	gridX: number,
	gridY: number,
	seed: number
): { x: number; y: number } {
	const source =
		TERRAFORMS_HYPERCASTLE_SURFACE_GRADIENTS[
			hashGridPoint(gridX, gridY, seed) % TERRAFORMS_HYPERCASTLE_SURFACE_GRADIENTS.length
		]!;
	const normalize = source[0] === 0 || source[1] === 0;
	return {
		x: source[0] * (normalize ? 1 : TERRAFORMS_HYPERCASTLE_SURFACE_GRADIENT_NORMALIZER),
		y: source[1] * (normalize ? 1 : TERRAFORMS_HYPERCASTLE_SURFACE_GRADIENT_NORMALIZER)
	};
}

function hashGridPoint(x: number, y: number, seed: number): number {
	let hash =
		Math.imul(x, TERRAFORMS_HYPERCASTLE_SURFACE_NOISE.hashX) ^
		Math.imul(y, TERRAFORMS_HYPERCASTLE_SURFACE_NOISE.hashY) ^
		Math.imul(seed, TERRAFORMS_HYPERCASTLE_SURFACE_NOISE.hashSeed);
	hash = Math.imul(
		hash ^ (hash >>> TERRAFORMS_HYPERCASTLE_SURFACE_NOISE.hashShift),
		TERRAFORMS_HYPERCASTLE_SURFACE_NOISE.hashFinal
	);
	return hash >>> 0;
}

function fade(value: number): number {
	return value * value * value * (value * (value * 6 - 15) + 10);
}

function lerp(left: number, right: number, amount: number): number {
	return left + amount * (right - left);
}

function clampNoise(value: number): number {
	return Math.max(
		TERRAFORMS_HYPERCASTLE_SURFACE_MINIMUM_NOISE,
		Math.min(TERRAFORMS_HYPERCASTLE_SURFACE_MAXIMUM_NOISE, value)
	);
}
