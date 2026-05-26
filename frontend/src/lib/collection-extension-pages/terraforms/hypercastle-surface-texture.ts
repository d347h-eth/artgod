import {
	resolveTerraformsTopographyBucket,
	TERRAFORMS_HYPERCASTLE_LEVELS,
	TERRAFORMS_ZONES,
	type TerraformsZone
} from '@artgod/shared/extensions/terraforms';

export type TerraformsHypercastleLevelSurface = {
	readonly levelNumber: number;
	readonly zoneIndex: number;
	readonly seed: number;
};

export type TerraformsHypercastleSurfaceTextureCell = {
	x: number;
	y: number;
	size: number;
	color: string;
	heightmapIndex: number;
	terrainValue: number;
};

type TerraformsHypercastleSurfaceRandom = () => number;

// DOM hooks for generated level textures and their reroll control.
export const TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_DOM = {
	ids: {
		patternPrefix: 'terraforms-hypercastle-level-surface-'
	},
	testIds: {
		rerollButton: 'terraforms-hypercastle-surface-reroll'
	},
	classes: {
		rerollButton: 'terraforms-hypercastle-surface-reroll'
	}
} as const;

// Compact control labels owned by the Terraforms Hypercastle texture controls.
export const TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_LABELS = {
	RerollSurfaces: 'reroll surfaces'
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
const TERRAFORMS_HYPERCASTLE_SURFACE_RANDOM_SEED_LIMIT = 1_000_000;
export const TERRAFORMS_HYPERCASTLE_SURFACE_HEIGHT_COLOR_COUNT = 9;
export const TERRAFORMS_HYPERCASTLE_SURFACE_BACKGROUND_COLOR_INDEX = 9;
const TERRAFORMS_HYPERCASTLE_SURFACE_MONO_PALETTE_HASH_X = 0;
const TERRAFORMS_HYPERCASTLE_SURFACE_MONO_PALETTE_HASH_Y = 0;
const TERRAFORMS_HYPERCASTLE_SURFACE_PATTERN_FILL_PREFIX = 'url(#';
const TERRAFORMS_HYPERCASTLE_SURFACE_PATTERN_FILL_SUFFIX = ')';
const TERRAFORMS_HYPERCASTLE_SURFACE_RENDER_KEY_FIELD_SEPARATOR = ':';
const TERRAFORMS_HYPERCASTLE_SURFACE_RENDER_KEY_LAYER_SEPARATOR = '|';
const TERRAFORMS_HYPERCASTLE_SURFACE_ERRORS = {
	unknownLevel: 'unknown Terraforms Hypercastle surface level',
	unknownZone: 'unknown Terraforms Hypercastle surface Zone',
	unavailableZone: 'Terraforms Hypercastle surface Zone is unavailable on the level'
} as const;

// Creates one transient surface texture choice for every Hypercastle level.
export function buildTerraformsHypercastleLevelSurfaces(input: {
	random?: TerraformsHypercastleSurfaceRandom;
} = {}): TerraformsHypercastleLevelSurface[] {
	const random = input.random ?? Math.random;
	return TERRAFORMS_HYPERCASTLE_LEVELS.map((level) =>
		buildTerraformsHypercastleRandomLevelSurface({
			levelNumber: level.levelNumber,
			zoneIndexes: level.zones.map((zone) => zone.index),
			random
		})
	);
}

// Replaces one level's surface after the user picks a Zone palette from the table.
export function replaceTerraformsHypercastleLevelSurface(input: {
	surfaces: readonly TerraformsHypercastleLevelSurface[];
	levelNumber: number;
	zoneIndex: number;
	random?: TerraformsHypercastleSurfaceRandom;
}): TerraformsHypercastleLevelSurface[] {
	const level = TERRAFORMS_HYPERCASTLE_LEVELS.find(
		(candidate) => candidate.levelNumber === input.levelNumber
	);
	if (!level) {
		throw new Error(TERRAFORMS_HYPERCASTLE_SURFACE_ERRORS.unknownLevel);
	}
	if (!level.zones.some((zone) => zone.index === input.zoneIndex)) {
		throw new Error(TERRAFORMS_HYPERCASTLE_SURFACE_ERRORS.unavailableZone);
	}

	const random = input.random ?? Math.random;
	const replacement: TerraformsHypercastleLevelSurface = {
		levelNumber: input.levelNumber,
		zoneIndex: input.zoneIndex,
		seed: resolveTerraformsHypercastleRandomSurfaceSeed(random)
	};
	let found = false;
	const surfaces = input.surfaces.map((surface) => {
		if (surface.levelNumber !== input.levelNumber) return surface;
		found = true;
		return replacement;
	});
	return found ? surfaces : [...surfaces, replacement];
}

// Resolves the transient surface state currently assigned to a level.
export function resolveTerraformsHypercastleSurfaceForLevel(
	surfaces: readonly TerraformsHypercastleLevelSurface[],
	levelNumber: number
): TerraformsHypercastleLevelSurface | null {
	return surfaces.find((surface) => surface.levelNumber === levelNumber) ?? null;
}

// Resolves the Zone whose palette paints a generated level surface.
export function resolveTerraformsHypercastleSurfaceZone(
	surface: TerraformsHypercastleLevelSurface
): TerraformsZone {
	const zone = TERRAFORMS_ZONES.find((candidate) => candidate.index === surface.zoneIndex);
	if (!zone) {
		throw new Error(TERRAFORMS_HYPERCASTLE_SURFACE_ERRORS.unknownZone);
	}
	return zone;
}

// The final palette color is the canonical Terraforms background fill.
export function resolveTerraformsHypercastleSurfaceTextureBackgroundColor(
	surface: TerraformsHypercastleLevelSurface
): string {
	const palette = resolveTerraformsHypercastleSurfaceZone(surface).palette;
	return palette[TERRAFORMS_HYPERCASTLE_SURFACE_BACKGROUND_COLOR_INDEX]!;
}

// Builds the SVG fill value for the generated texture pattern.
export function resolveTerraformsHypercastleSurfaceTexturePatternId(levelNumber: number): string {
	return `${TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_DOM.ids.patternPrefix}${levelNumber}`;
}

// Builds the SVG fill value for the generated texture pattern.
export function resolveTerraformsHypercastleSurfaceTexturePatternFill(
	levelNumber: number
): string {
	return [
		TERRAFORMS_HYPERCASTLE_SURFACE_PATTERN_FILL_PREFIX,
		resolveTerraformsHypercastleSurfaceTexturePatternId(levelNumber),
		TERRAFORMS_HYPERCASTLE_SURFACE_PATTERN_FILL_SUFFIX
	].join('');
}

// Serializes transient level surfaces into one stable render attribute.
export function buildTerraformsHypercastleSurfaceTextureRenderKey(
	surfaces: readonly TerraformsHypercastleLevelSurface[]
): string {
	return surfaces
		.map((surface) =>
			[surface.levelNumber, surface.zoneIndex, surface.seed].join(
				TERRAFORMS_HYPERCASTLE_SURFACE_RENDER_KEY_FIELD_SEPARATOR
			)
		)
		.join(TERRAFORMS_HYPERCASTLE_SURFACE_RENDER_KEY_LAYER_SEPARATOR);
}

// Generates a parcel-local Perlin heightmap and stretches it over the slab top face.
export function buildTerraformsHypercastleSurfaceTextureCells(input: {
	zone: TerraformsZone;
	seed: number;
}): TerraformsHypercastleSurfaceTextureCell[] {
	const cellSize = 1 / TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_GRID_SIZE;
	const palette = resolveTerraformsHypercastleSurfaceTexturePalette({
		zone: input.zone,
		seed: input.seed
	});
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
				color: palette[heightmapIndex]!,
				heightmapIndex,
				terrainValue
			});
		}
	}
	return cells;
}

// Reintroduces the canonical background fill into flat mono-palette surfaces.
export function resolveTerraformsHypercastleSurfaceTexturePalette(input: {
	zone: TerraformsZone;
	seed: number;
}): readonly string[] {
	const palette = [...input.zone.palette];
	if (!isTerraformsHypercastleMonoSurfacePalette(palette)) {
		return palette;
	}
	palette[resolveTerraformsHypercastleMonoBackgroundHeightIndex(input.seed)] =
		palette[TERRAFORMS_HYPERCASTLE_SURFACE_BACKGROUND_COLOR_INDEX]!;
	return palette;
}

function buildTerraformsHypercastleRandomLevelSurface(input: {
	levelNumber: number;
	zoneIndexes: readonly number[];
	random: TerraformsHypercastleSurfaceRandom;
}): TerraformsHypercastleLevelSurface {
	return {
		levelNumber: input.levelNumber,
		zoneIndex: input.zoneIndexes[resolveTerraformsHypercastleRandomIndex(input.zoneIndexes, input.random)]!,
		seed: resolveTerraformsHypercastleRandomSurfaceSeed(input.random)
	};
}

function resolveTerraformsHypercastleRandomIndex(
	values: readonly unknown[],
	random: TerraformsHypercastleSurfaceRandom
): number {
	return Math.min(Math.floor(random() * values.length), values.length - 1);
}

function resolveTerraformsHypercastleRandomSurfaceSeed(
	random: TerraformsHypercastleSurfaceRandom
): number {
	return Math.min(
		Math.floor(random() * TERRAFORMS_HYPERCASTLE_SURFACE_RANDOM_SEED_LIMIT),
		TERRAFORMS_HYPERCASTLE_SURFACE_RANDOM_SEED_LIMIT - 1
	);
}

function isTerraformsHypercastleMonoSurfacePalette(palette: readonly string[]): boolean {
	return (
		new Set(palette.slice(0, TERRAFORMS_HYPERCASTLE_SURFACE_HEIGHT_COLOR_COUNT)).size === 1
	);
}

function resolveTerraformsHypercastleMonoBackgroundHeightIndex(seed: number): number {
	return (
		hashGridPoint(
			TERRAFORMS_HYPERCASTLE_SURFACE_MONO_PALETTE_HASH_X,
			TERRAFORMS_HYPERCASTLE_SURFACE_MONO_PALETTE_HASH_Y,
			seed
		) % TERRAFORMS_HYPERCASTLE_SURFACE_HEIGHT_COLOR_COUNT
	);
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
