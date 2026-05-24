import {
	TERRAFORMS_HYPERCASTLE_MAX_LEVEL_DIMENSION,
	TERRAFORMS_TOPOGRAPHY_BUCKET_COUNT,
	TERRAFORMS_ZONES,
	type TerraformsLevelSummary,
	type TerraformsLevelZoneBucket,
	type TerraformsZone
} from '@artgod/shared/extensions/terraforms';

export type TerraformsHypercastleIsometricBand = {
	readonly bucket: TerraformsLevelZoneBucket;
	readonly zone: TerraformsZone;
	readonly topographyRank: number;
	readonly right: number;
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
	readonly fillColor: string;
	readonly strokeColor: string;
};

const ISOMETRIC_DISPLAY_MIN_DIMENSION = 16;
const ISOMETRIC_DISPLAY_DIMENSION_RANGE = 24;
const ISOMETRIC_RING_DENSITY = 2.4;
const ISOMETRIC_MIN_BAND_SIZE_RATIO = 0.24;
const ISOMETRIC_ELEVATION_UNIT = 0.22;

// Builds nine aggregate isometric bands for a focused level instead of 1:1 parcel tiles.
export function buildTerraformsHypercastleIsometricBands(
	level: TerraformsLevelSummary
): TerraformsHypercastleIsometricBand[] {
	const displayDimension = resolveTerraformsHypercastleIsometricDisplayDimension(level);
	const ringUnit = displayDimension / (TERRAFORMS_TOPOGRAPHY_BUCKET_COUNT * ISOMETRIC_RING_DENSITY);
	const minimumBandSize = displayDimension * ISOMETRIC_MIN_BAND_SIZE_RATIO;

	return [...level.topographyZoneBuckets]
		.sort((left, right) => right.topographyBucketIndex - left.topographyBucketIndex)
		.map((bucket) => {
			const topographyRank = resolveTerraformsTopographyRank(bucket);
			const inset = topographyRank * ringUnit;
			const size = Math.max(displayDimension - inset * 2, minimumBandSize);
			const zone = TERRAFORMS_ZONES[bucket.zoneIndex]!;
			return {
				bucket,
				zone,
				topographyRank,
				right: inset,
				left: inset,
				top: bucket.elevation * ISOMETRIC_ELEVATION_UNIT,
				width: size,
				height: size,
				fillColor: resolveTerraformsHypercastleBandFillColor(zone, bucket),
				strokeColor: resolveTerraformsHypercastleBandStrokeColor(zone, bucket)
			};
		});
}

export function resolveTerraformsHypercastleSelectedBucket(
	level: TerraformsLevelSummary,
	selectedBucketIndex: number | null
): TerraformsLevelZoneBucket {
	return (
		level.topographyZoneBuckets.find(
			(bucket) => bucket.topographyBucketIndex === selectedBucketIndex
		) ?? level.topographyZoneBuckets[0]!
	);
}

export function buildTerraformsHypercastleIsometricRenderKey(
	level: TerraformsLevelSummary,
	selectedBucket: TerraformsLevelZoneBucket | null
): string {
	return `${level.levelNumber}:${selectedBucket?.topographyBucketIndex ?? ''}`;
}

function resolveTerraformsHypercastleIsometricDisplayDimension(
	level: TerraformsLevelSummary
): number {
	return (
		ISOMETRIC_DISPLAY_MIN_DIMENSION +
		(level.dimension / TERRAFORMS_HYPERCASTLE_MAX_LEVEL_DIMENSION) *
			ISOMETRIC_DISPLAY_DIMENSION_RANGE
	);
}

function resolveTerraformsTopographyRank(bucket: TerraformsLevelZoneBucket): number {
	return TERRAFORMS_TOPOGRAPHY_BUCKET_COUNT - 1 - bucket.topographyBucketIndex;
}

function resolveTerraformsHypercastleBandFillColor(
	zone: TerraformsZone,
	bucket: TerraformsLevelZoneBucket
): string {
	return zone.palette[bucket.topographyBucketIndex % zone.palette.length]!;
}

function resolveTerraformsHypercastleBandStrokeColor(
	zone: TerraformsZone,
	bucket: TerraformsLevelZoneBucket
): string {
	return zone.palette[(bucket.topographyBucketIndex + 1) % zone.palette.length]!;
}
