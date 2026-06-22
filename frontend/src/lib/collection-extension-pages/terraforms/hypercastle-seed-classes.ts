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
	| 'x-seed'
	| 'y-seed';

export type TerraformsHypercastleSeedClassRow = {
	key: TerraformsHypercastleSeedClassRowKey;
	label: string;
	condition: string;
	effect: string;
	traitValue: string;
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
		tokenList: 'terraforms-hypercastle-seed-classes-token-list',
		table: 'terraforms-hypercastle-seed-classes-table',
		tableLink: 'terraforms-hypercastle-seed-classes-table-link'
	},
	testIds: {
		root: 'terraforms-hypercastle-seed-classes',
		seedClassTable: 'terraforms-hypercastle-seed-class-table'
	}
} as const;

// User-facing copy for the Terraforms Hypercastle seed-class section.
export const TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS = {
	Heading: 'Origins / Seed Classes',
	SeedTraitsHeading: 'Seed traits',
	SeedClassesHeading: 'Seed Class trait buckets',
	GodmodeHeading: 'Godmode parcels',
	SeedTraitCopy:
		'The hidden renderer seed is stored as the Seed range trait. Seed Class is written only for the named cases below.',
	GodmodeCopy:
		'Godmode means an Origin parcel with overdrive active: every character range is available and passive playback uses the full character set.',
	ClassColumn: 'class',
	ConditionColumn: 'when',
	EffectColumn: 'effect',
	GodmodeTokenPrefix: 'Known Godmode parcels:'
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
const OVERDRIVE_MIN_SEED = TERRAFORMS_RENDERER_SEED_THRESHOLDS.OverdriveLowerExclusive + 1n;
const ORIGIN_X_MIN_SEED = TERRAFORMS_RENDERER_SEED_THRESHOLDS.OriginXSeed + 1n;
const NON_ORIGIN_X_MIN_SEED = TERRAFORMS_RENDERER_SEED_THRESHOLDS.NonOriginXSeed + 1n;
const Y_SEED_MAX = TERRAFORMS_RENDERER_SEED_THRESHOLDS.YSeedUpperInclusive;
const MAX_SEED = TERRAFORMS_RENDERER_SEED_THRESHOLDS.Modulus - 1n;

// Seed Class rows map first-class trait values to their compact renderer conditions.
export const TERRAFORMS_HYPERCASTLE_SEED_CLASS_ROWS: readonly TerraformsHypercastleSeedClassRow[] = [
	{
		key: 'x-seed',
		label: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed,
		condition: `${ORIGIN_MODE_LABEL}: ${formatSeedRange(
			ORIGIN_X_MIN_SEED,
			TERRAFORMS_RENDERER_SEED_THRESHOLDS.OverdriveLowerExclusive
		)}; ${NON_ORIGIN_MODE_LABEL}: ${formatSeedRange(NON_ORIGIN_X_MIN_SEED, MAX_SEED)}`,
		effect: 'all character ranges',
		traitValue: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed
	},
	{
		key: 'y-seed',
		label: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.YSeed,
		condition: `${NON_ORIGIN_MODE_LABEL}: ${formatSeedRange(OVERDRIVE_MIN_SEED, Y_SEED_MAX)}`,
		effect: 'one early character range reverses',
		traitValue: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.YSeed
	},
	{
		key: 'godmode',
		label: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.Godmode,
		condition: `${ORIGIN_MODE_LABEL}; ${formatSeedGreaterThan(
			TERRAFORMS_RENDERER_SEED_THRESHOLDS.OverdriveLowerExclusive
		)}`,
		effect: 'all ranges + full passive character set',
		traitValue: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.Godmode
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
