import {
	TERRAFORMS_MODE_ATTRIBUTE_VALUES,
	TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY,
	TERRAFORMS_RENDERER_SEED_THRESHOLDS,
	TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY,
	TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES
} from '@artgod/shared/extensions/terraforms';
import { joinPath } from '$lib/route-paths';
import { buildTerraformsHypercastleTraitTokenHref } from '$lib/collection-extension-pages/terraforms/hypercastle-token-links';

type TerraformsHypercastleSeedClassRowKey =
	| 'godmode'
	| 'origin-x-seed'
	| 'non-origin-x-seed'
	| 'non-origin-y-seed'
	| 'ordinary';

type TerraformsHypercastleRendererBucketRowKey =
	| 'ordinary-non-origin'
	| 'non-origin-y-seed'
	| 'non-origin-x-seed'
	| 'ordinary-origin'
	| 'origin-x-seed'
	| 'godmode';

export type TerraformsHypercastleSeedClassRow = {
	key: TerraformsHypercastleSeedClassRowKey;
	label: string;
	condition: string;
	runtime: string;
	traitValue: string | null;
};

export type TerraformsHypercastleRendererBucketRow = {
	key: TerraformsHypercastleRendererBucketRowKey;
	label: string;
	condition: string;
	runtime: string;
	seedClass: string;
};

export type TerraformsHypercastleGodmodeToken = {
	tokenId: string;
	mode: string;
	seed: string;
};

// DOM contracts for the Terraforms Hypercastle seed-class section.
export const TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM = {
	classes: {
		root: 'terraforms-hypercastle-seed-classes',
		section: 'terraforms-hypercastle-seed-classes-section',
		heading: 'terraforms-hypercastle-seed-classes-heading',
		subheading: 'terraforms-hypercastle-seed-classes-subheading',
		copy: 'terraforms-hypercastle-seed-classes-copy',
		table: 'terraforms-hypercastle-seed-classes-table',
		tableLink: 'terraforms-hypercastle-seed-classes-table-link',
		numericCell: 'terraforms-hypercastle-seed-classes-numeric-cell'
	},
	testIds: {
		root: 'terraforms-hypercastle-seed-classes',
		seedClassTable: 'terraforms-hypercastle-seed-class-table',
		rendererBucketTable: 'terraforms-hypercastle-renderer-bucket-table'
	}
} as const;

// User-facing copy for the Terraforms Hypercastle seed-class section.
export const TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS = {
	Heading: 'Origins / Seed Classes',
	SeedTraitsHeading: 'Seed traits',
	SeedClassesHeading: 'Seed Class trait buckets',
	RendererBucketsHeading: 'Canonical animation buckets',
	GodmodeHeading: 'Godmode parcels',
	SeedTraitCopy:
		'The hidden renderer seed is derived from placement, level, and tile, then stored as the Seed range trait. Seed Class is an extension-owned normalized trait that names renderer branches with distinct character-set behavior.',
	RendererCopy:
		'The animation script computes the Y flag first, then chooses an origin or non-origin seedSet branch. Origin parcels above the overdrive threshold enter the origin X-seed branch and then switch passive playback to the full character set.',
	GodmodeCopy:
		'Godmode means an Origin parcel with overdrive active: the renderer uses every uni range and height-0 passive playback uses the full charSet.',
	ClassColumn: 'class',
	ConditionColumn: 'condition',
	RuntimeColumn: 'runtime',
	SeedClassColumn: 'seed class',
	TokenColumn: 'token',
	ModeColumn: 'mode',
	SeedColumn: TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY
} as const;

const NON_ORIGIN_MODE_LABEL = [
	TERRAFORMS_MODE_ATTRIBUTE_VALUES.Terrain,
	TERRAFORMS_MODE_ATTRIBUTE_VALUES.Daydream,
	TERRAFORMS_MODE_ATTRIBUTE_VALUES.Terraform
].join(' / ');
const ORIGIN_MODE_LABEL = [
	TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginDaydream,
	TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginTerraform
].join(' / ');
const ORDINARY_SEED_CLASS_LABEL = 'none';
const OVERDRIVE_MIN_SEED = TERRAFORMS_RENDERER_SEED_THRESHOLDS.OverdriveLowerExclusive + 1n;
const ORIGIN_X_MIN_SEED = TERRAFORMS_RENDERER_SEED_THRESHOLDS.OriginXSeed + 1n;
const NON_ORIGIN_X_MIN_SEED = TERRAFORMS_RENDERER_SEED_THRESHOLDS.NonOriginXSeed + 1n;
const Y_SEED_MAX = TERRAFORMS_RENDERER_SEED_THRESHOLDS.YSeedUpperInclusive;
const MAX_SEED = TERRAFORMS_RENDERER_SEED_THRESHOLDS.Modulus - 1n;

// Seed Class rows map exclusive first-class trait values to renderer conditions.
export const TERRAFORMS_HYPERCASTLE_SEED_CLASS_ROWS: readonly TerraformsHypercastleSeedClassRow[] = [
	{
		key: 'godmode',
		label: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.Godmode,
		condition: `${ORIGIN_MODE_LABEL}; ${formatSeedGreaterThan(
			TERRAFORMS_RENDERER_SEED_THRESHOLDS.OverdriveLowerExclusive
		)}`,
		runtime: 'origin X-seed path plus overdrive; passive playback uses the full charSet',
		traitValue: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.Godmode
	},
	{
		key: 'origin-x-seed',
		label: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed,
		condition: `${ORIGIN_MODE_LABEL}; ${formatSeedRange(ORIGIN_X_MIN_SEED, TERRAFORMS_RENDERER_SEED_THRESHOLDS.OverdriveLowerExclusive)}`,
		runtime: 'origin X-seed path; every uni range is available to painted cells',
		traitValue: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed
	},
	{
		key: 'non-origin-x-seed',
		label: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed,
		condition: `${NON_ORIGIN_MODE_LABEL}; ${formatSeedGreaterThan(
			TERRAFORMS_RENDERER_SEED_THRESHOLDS.NonOriginXSeed
		)}`,
		runtime: 'non-origin X-seed path; every uni range is available and overdrive is active',
		traitValue: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed
	},
	{
		key: 'non-origin-y-seed',
		label: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.YSeed,
		condition: `${NON_ORIGIN_MODE_LABEL}; ${formatSeedRange(OVERDRIVE_MIN_SEED, Y_SEED_MAX)}`,
		runtime: 'non-origin Y-seed path; one of the first three uni ranges is reversed',
		traitValue: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.YSeed
	},
	{
		key: 'ordinary',
		label: ORDINARY_SEED_CLASS_LABEL,
		condition: 'all remaining seed and mode combinations',
		runtime: 'no Seed Class trait is written',
		traitValue: null
	}
] as const;

// Renderer bucket rows preserve the full animation branch breakdown.
export const TERRAFORMS_HYPERCASTLE_RENDERER_BUCKET_ROWS: readonly TerraformsHypercastleRendererBucketRow[] =
	[
		{
			key: 'ordinary-non-origin',
			label: 'Ordinary non-origin',
			condition: `${NON_ORIGIN_MODE_LABEL}; ${formatSeedAtMost(
				TERRAFORMS_RENDERER_SEED_THRESHOLDS.OverdriveLowerExclusive
			)}`,
			runtime: 'blade rail sequencer pattern',
			seedClass: ORDINARY_SEED_CLASS_LABEL
		},
		{
			key: 'non-origin-y-seed',
			label: 'Non-origin Y-seed',
			condition: `${NON_ORIGIN_MODE_LABEL}; ${formatSeedRange(OVERDRIVE_MIN_SEED, Y_SEED_MAX)}`,
			runtime: 'reversed one-of-first-three uni range; overdrive active',
			seedClass: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.YSeed
		},
		{
			key: 'non-origin-x-seed',
			label: 'Non-origin X-seed',
			condition: `${NON_ORIGIN_MODE_LABEL}; ${formatSeedRange(NON_ORIGIN_X_MIN_SEED, MAX_SEED)}`,
			runtime: 'every uni range; overdrive active',
			seedClass: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed
		},
		{
			key: 'ordinary-origin',
			label: 'Ordinary origin',
			condition: `${ORIGIN_MODE_LABEL}; ${formatSeedAtMost(
				TERRAFORMS_RENDERER_SEED_THRESHOLDS.OriginXSeed
			)}`,
			runtime: 'one uni range plus the origin extra pattern',
			seedClass: ORDINARY_SEED_CLASS_LABEL
		},
		{
			key: 'origin-x-seed',
			label: 'Origin X-seed',
			condition: `${ORIGIN_MODE_LABEL}; ${formatSeedRange(
				ORIGIN_X_MIN_SEED,
				TERRAFORMS_RENDERER_SEED_THRESHOLDS.OverdriveLowerExclusive
			)}`,
			runtime: 'every uni range; passive height-0 playback uses original/core chars',
			seedClass: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed
		},
		{
			key: 'godmode',
			label: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.Godmode,
			condition: `${ORIGIN_MODE_LABEL}; ${formatSeedRange(OVERDRIVE_MIN_SEED, MAX_SEED)}`,
			runtime: 'every uni range; passive height-0 playback uses the full charSet',
			seedClass: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.Godmode
		}
	] as const;

// Canonical Godmode parcels in the original Terraforms collection.
export const TERRAFORMS_HYPERCASTLE_GODMODE_TOKENS: readonly TerraformsHypercastleGodmodeToken[] =
	[
		{
			tokenId: '83',
			mode: TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginDaydream,
			seed: '9980'
		},
		{
			tokenId: '1955',
			mode: TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginDaydream,
			seed: '9983'
		},
		{
			tokenId: '124',
			mode: TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginDaydream,
			seed: '9996'
		}
	] as const;

// Builds a token-browser href for one Terraforms Seed Class bucket.
export function buildTerraformsSeedClassTokenHref(input: {
	basePath: string;
	mediaMode?: string | null;
	seedClass: string;
}): string {
	return buildTerraformsHypercastleTraitTokenHref({
		basePath: input.basePath,
		mediaMode: input.mediaMode,
		traitKey: TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY,
		traitValue: input.seedClass
	});
}

// Builds a token-detail href for a canonical Terraforms token id.
export function buildTerraformsHypercastleTokenHref(basePath: string, tokenId: string): string {
	return joinPath(basePath, tokenId);
}

// Formats Terraforms token labels for the canonical Godmode parcel table.
export function formatTerraformsHypercastleTokenLabel(tokenId: string): string {
	return `#${tokenId}`;
}

function formatSeedRange(minInclusive: bigint, maxInclusive: bigint): string {
	return `${TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY} ${minInclusive.toString()}-${maxInclusive.toString()}`;
}

function formatSeedGreaterThan(lowerExclusive: bigint): string {
	return `${TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY} > ${lowerExclusive.toString()}`;
}

function formatSeedAtMost(maxInclusive: bigint): string {
	return `${TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY} <= ${maxInclusive.toString()}`;
}
