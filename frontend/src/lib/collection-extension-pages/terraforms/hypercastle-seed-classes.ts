import {
	TERRAFORMS_MODE_ATTRIBUTE_KEY,
	TERRAFORMS_MODE_ATTRIBUTE_VALUES,
	buildTerraformsRendererExtraCharacterRanges,
	TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY,
	TERRAFORMS_RENDERER_SEED_THRESHOLDS,
	TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY,
	TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES
} from '@artgod/shared/extensions/terraforms';
import { TOKEN_BROWSER_STATUS } from '@artgod/shared/types/browse';
import type { ApiCollectionMediaPreference, ApiTokenCard } from '$lib/api-types';
import {
	buildTerraformsHypercastleTraitTokenHref,
	buildTerraformsHypercastleTraitsTokenHref
} from '$lib/collection-extension-pages/terraforms/hypercastle-token-links';
import {
	buildTokenBrowserQuery,
	buildTokenDetailHref,
	normalizeTokenBrowserParams,
	TOKEN_BROWSER_DISPLAY_MODES
} from '$lib/token-browser-query';

type TerraformsHypercastleSeedClassRowKey = 'godmode' | 'x-seed' | 'y-seed';

export type TerraformsHypercastleExtraCharacterSet = {
	key: string;
	characters: readonly string[];
	characterLabels: readonly string[];
};

export type TerraformsHypercastleLinkedSummary = {
	linkLabel: string;
	rest: string;
};

export type TerraformsHypercastleSeedClassRow = {
	key: TerraformsHypercastleSeedClassRowKey;
	heading: string;
	label: string;
	condition: string;
	summary: TerraformsHypercastleLinkedSummary;
	traitValue: string;
	rerollable: boolean;
	characterSets?: readonly TerraformsHypercastleExtraCharacterSet[];
};

export type TerraformsHypercastleOriginSection = {
	heading: string;
	condition: string;
	summary: TerraformsHypercastleLinkedSummary;
	characterSets: readonly TerraformsHypercastleExtraCharacterSet[];
};

export type TerraformsHypercastleGodmodeToken = {
	tokenId: string;
	mode: string;
	seed: string;
};

export type TerraformsHypercastleSeedClassSampleStatus =
	(typeof TERRAFORMS_HYPERCASTLE_SEED_CLASS_SAMPLE_STATUS)[keyof typeof TERRAFORMS_HYPERCASTLE_SEED_CLASS_SAMPLE_STATUS];

export type TerraformsHypercastleSeedClassSampleState = {
	status: TerraformsHypercastleSeedClassSampleStatus;
	pool: ApiTokenCard[];
	visible: ApiTokenCard[];
};

export const TERRAFORMS_HYPERCASTLE_SEED_CLASS_SAMPLE_STATUS = {
	Idle: 'idle',
	Loading: 'loading',
	Ready: 'ready',
	Error: 'error'
} as const;

export const TERRAFORMS_HYPERCASTLE_SEED_CLASS_SAMPLE_COUNT = 3;
export const TERRAFORMS_HYPERCASTLE_SEED_CLASS_SAMPLE_POOL_LIMIT = 100;

// Stable sample-state key for Origin examples, which are mode-filtered rather than Seed Class filtered.
export const TERRAFORMS_HYPERCASTLE_ORIGIN_SAMPLE_KEY = 'origins';

// DOM contracts for the Terraforms Hypercastle seed-class section.
export const TERRAFORMS_HYPERCASTLE_SEED_CLASS_DOM = {
	classes: {
		root: 'terraforms-hypercastle-seed-classes',
		section: 'terraforms-hypercastle-seed-classes-section',
		heading: 'terraforms-hypercastle-seed-classes-heading',
		subheading: 'terraforms-hypercastle-seed-classes-subheading',
		copy: 'terraforms-hypercastle-seed-classes-copy',
		list: 'terraforms-hypercastle-seed-classes-list',
		block: 'terraforms-hypercastle-seed-classes-block',
		copyLink: 'terraforms-hypercastle-seed-classes-copy-link',
		rerollButton: 'terraforms-hypercastle-seed-classes-reroll-button',
		condition: 'terraforms-hypercastle-seed-classes-condition',
		characterSets: 'terraforms-hypercastle-seed-classes-character-sets',
		sampleGroup: 'terraforms-hypercastle-seed-classes-sample-group',
		sampleActions: 'terraforms-hypercastle-seed-classes-sample-actions',
		sampleGrid: 'terraforms-hypercastle-seed-classes-sample-grid',
		status: 'terraforms-hypercastle-seed-classes-status'
	},
	testIds: {
		root: 'terraforms-hypercastle-seed-classes',
		seedClassList: 'terraforms-hypercastle-seed-class-list',
		seedClassBlock: 'terraforms-hypercastle-seed-class-block',
		characterSets: 'terraforms-hypercastle-seed-class-character-sets',
		sampleGrid: 'terraforms-hypercastle-seed-class-sample-grid',
		rerollButton: 'terraforms-hypercastle-seed-class-reroll'
	}
} as const;

// User-facing copy for the Terraforms Hypercastle seed-class section.
export const TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS = {
	Heading: 'Origins / Seed Classes',
	SeedTraitsHeading: 'Seed value trait',
	OriginsHeading: 'Origins',
	SeedClassHeadingPrefix: 'Seed Class',
	OriginScope: 'Origin',
	NonOriginScope: 'Non-Origin',
	SeedTraitCopy:
		'Each parcel has a hidden seed that shapes its rendered character set. Specific seed ranges create the special Seed Classes below.',
	OriginsCondition: 'Mode: Origin',
	OriginsCopyLink: 'Origin parcels',
	OriginsCopyRest:
		' were created through the mintpass redemption path and keep their Origin lineage after terraforming.',
	SampleLoading: 'loading examples',
	SampleEmpty: 'no examples found',
	SampleError: 'examples unavailable',
	Reroll: 'reroll examples'
} as const;

const OVERDRIVE_MIN_SEED = TERRAFORMS_RENDERER_SEED_THRESHOLDS.OverdriveLowerExclusive + 1n;
const ORIGIN_X_MIN_SEED = TERRAFORMS_RENDERER_SEED_THRESHOLDS.OriginXSeed + 1n;
const NON_ORIGIN_X_MIN_SEED = TERRAFORMS_RENDERER_SEED_THRESHOLDS.NonOriginXSeed + 1n;
const Y_SEED_MAX = TERRAFORMS_RENDERER_SEED_THRESHOLDS.YSeedUpperInclusive;
const MIN_SEED = 0n;
const MAX_SEED = TERRAFORMS_RENDERER_SEED_THRESHOLDS.Modulus - 1n;
const EXTRA_CHARACTER_SET_KEY_PREFIX = 'extra-character-set';
const Y_SEED_CHARACTER_SET_KEY_PART = 'y-seed';

// Y-Seeds select from the first three Origin charsets, then reverse the characters.
export const TERRAFORMS_HYPERCASTLE_Y_SEED_CHARACTER_SET_COUNT = 3;

// Extra charsets mirror the V2 renderer order used by X-Seeds and Godmode.
export const TERRAFORMS_HYPERCASTLE_EXTRA_CHARACTER_SETS: readonly TerraformsHypercastleExtraCharacterSet[] =
	buildTerraformsRendererExtraCharacterRanges().map((characters, index) => ({
		key: [EXTRA_CHARACTER_SET_KEY_PREFIX, String(index)].join('-'),
		characters,
		characterLabels: characters
	}));

// Y-Seeds reverse the character order inside one of the first three Origin charsets.
export const TERRAFORMS_HYPERCASTLE_Y_SEED_CHARACTER_SETS: readonly TerraformsHypercastleExtraCharacterSet[] =
	TERRAFORMS_HYPERCASTLE_EXTRA_CHARACTER_SETS.slice(
		0,
		TERRAFORMS_HYPERCASTLE_Y_SEED_CHARACTER_SET_COUNT
	).map((characterSet, index) => ({
		key: [EXTRA_CHARACTER_SET_KEY_PREFIX, Y_SEED_CHARACTER_SET_KEY_PART, String(index)].join('-'),
		characters: [...characterSet.characters].reverse(),
		characterLabels: [...characterSet.characterLabels].reverse()
	}));

// Origin is a mode lineage with renderer branches, not a Seed Class trait value.
export const TERRAFORMS_HYPERCASTLE_ORIGIN_SECTION: TerraformsHypercastleOriginSection = {
	heading: TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.OriginsHeading,
	condition: `${TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.OriginsCondition}
${formatSeedLessThanOrEqual(TERRAFORMS_RENDERER_SEED_THRESHOLDS.OriginXSeed)}: one charset
${formatSeedGreaterThan(TERRAFORMS_RENDERER_SEED_THRESHOLDS.OriginXSeed)}: all charsets`,
	summary: {
		linkLabel: TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.OriginsCopyLink,
		rest: `${TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.OriginsCopyRest} ${formatSeedRange(
			MIN_SEED,
			TERRAFORMS_RENDERER_SEED_THRESHOLDS.OriginXSeed
		)} draws one charset from the non-biome set shown below. ${formatSeedRange(
			ORIGIN_X_MIN_SEED,
			MAX_SEED
		)} uses all of them.`
	},
	characterSets: TERRAFORMS_HYPERCASTLE_EXTRA_CHARACTER_SETS
};

// Canonical Godmode parcels in the original Terraforms collection.
export const TERRAFORMS_HYPERCASTLE_GODMODE_TOKENS: readonly TerraformsHypercastleGodmodeToken[] = [
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

// Seed Class rows map first-class trait values to their compact renderer conditions.
export const TERRAFORMS_HYPERCASTLE_SEED_CLASS_ROWS: readonly TerraformsHypercastleSeedClassRow[] =
	[
		{
			key: 'x-seed',
			heading: formatTerraformsSeedClassHeading(TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed),
			label: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed,
			condition: `${TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.OriginScope}: ${formatSeedRange(
				ORIGIN_X_MIN_SEED,
				TERRAFORMS_RENDERER_SEED_THRESHOLDS.OverdriveLowerExclusive
			)}
${TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.NonOriginScope}: ${formatSeedRange(NON_ORIGIN_X_MIN_SEED, MAX_SEED)}`,
			summary: {
				linkLabel: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed,
				rest: ' can draw from every non-biome charset shown in Origins.'
			},
			traitValue: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed,
			rerollable: true
		},
		{
			key: 'y-seed',
			heading: formatTerraformsSeedClassHeading(TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.YSeed),
			label: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.YSeed,
			condition: `${TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.NonOriginScope}: ${formatSeedRange(OVERDRIVE_MIN_SEED, Y_SEED_MAX)}`,
			summary: {
				linkLabel: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.YSeed,
				rest: ` are non-Origin tokens in the listed Seed range. Their renderer uses the reversed character order of one of the first ${TERRAFORMS_HYPERCASTLE_Y_SEED_CHARACTER_SET_COUNT} 10-character Origin charsets shown here.`
			},
			traitValue: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.YSeed,
			rerollable: true,
			characterSets: TERRAFORMS_HYPERCASTLE_Y_SEED_CHARACTER_SETS
		},
		{
			key: 'godmode',
			heading: formatTerraformsSeedClassHeading(TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.Godmode),
			label: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.Godmode,
			condition: `${TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.OriginScope}: ${formatSeedGreaterThan(
				TERRAFORMS_RENDERER_SEED_THRESHOLDS.OverdriveLowerExclusive
			)}`,
			summary: {
				linkLabel: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.Godmode,
				rest: ` is an Origin X-Seed in overdrive. It uses the same full non-biome charset set as X-Seeds; the difference is that passive height-0 cells also use that full set. Only ${TERRAFORMS_HYPERCASTLE_GODMODE_TOKENS.length} parcels are Godmode, shown below.`
			},
			traitValue: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.Godmode,
			rerollable: false
		}
	] as const;

// Builds a token-browser href for all Terraforms Origin parcels.
export function buildTerraformsOriginTokenHref(input: {
	basePath: string;
	mediaMode?: string | null;
	mediaPreference?: ApiCollectionMediaPreference | null;
}): string {
	return buildTerraformsHypercastleTraitsTokenHref({
		basePath: input.basePath,
		mediaMode: input.mediaMode,
		mediaPreference: input.mediaPreference,
		traits: [
			{
				key: TERRAFORMS_MODE_ATTRIBUTE_KEY,
				value: TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginDaydream
			},
			{
				key: TERRAFORMS_MODE_ATTRIBUTE_KEY,
				value: TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginTerraform
			}
		]
	});
}

// Builds the collection-detail query used to load Origin sample cards.
export function buildTerraformsOriginSampleQuery(input: {
	mediaMode?: string | null;
	mediaPreference?: ApiCollectionMediaPreference | null;
}): URLSearchParams {
	const raw = buildTokenBrowserQuery({
		limit: TERRAFORMS_HYPERCASTLE_SEED_CLASS_SAMPLE_POOL_LIMIT,
		displayMode: TOKEN_BROWSER_DISPLAY_MODES.Grid,
		tokenStatus: TOKEN_BROWSER_STATUS.All,
		selectedTraits: [
			{
				key: TERRAFORMS_MODE_ATTRIBUTE_KEY,
				value: TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginDaydream
			},
			{
				key: TERRAFORMS_MODE_ATTRIBUTE_KEY,
				value: TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginTerraform
			}
		],
		selectedTraitRanges: [],
		mediaMode: input.mediaMode ?? null,
		mediaPreference: input.mediaPreference ?? null
	});
	return normalizeTokenBrowserParams(raw, TOKEN_BROWSER_STATUS.All);
}

// Builds a token-browser href for one Terraforms Seed Class bucket.
export function buildTerraformsSeedClassTokenHref(input: {
	basePath: string;
	mediaMode?: string | null;
	mediaPreference?: ApiCollectionMediaPreference | null;
	seedClass: string;
}): string {
	return buildTerraformsHypercastleTraitTokenHref({
		basePath: input.basePath,
		mediaMode: input.mediaMode,
		mediaPreference: input.mediaPreference,
		traitKey: TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY,
		traitValue: input.seedClass
	});
}

// Builds a token-detail href for a Terraforms sample token card.
export function buildTerraformsHypercastleTokenHref(input: {
	basePath: string;
	tokenId: string;
	mediaMode?: string | null;
	mediaPreference?: ApiCollectionMediaPreference | null;
}): string {
	return buildTokenDetailHref({
		basePath: input.basePath,
		tokenId: input.tokenId,
		mediaMode: input.mediaMode ?? null,
		mediaPreference: input.mediaPreference ?? null
	});
}

// Formats Terraforms token labels for sample card metadata and tests.
export function formatTerraformsHypercastleTokenLabel(tokenId: string): string {
	return `#${tokenId}`;
}

// Builds the collection-detail query used to load Seed Class sample cards.
export function buildTerraformsSeedClassSampleQuery(input: {
	mediaMode?: string | null;
	mediaPreference?: ApiCollectionMediaPreference | null;
	seedClass: string;
}): URLSearchParams {
	const raw = buildTokenBrowserQuery({
		limit: TERRAFORMS_HYPERCASTLE_SEED_CLASS_SAMPLE_POOL_LIMIT,
		displayMode: TOKEN_BROWSER_DISPLAY_MODES.Grid,
		tokenStatus: TOKEN_BROWSER_STATUS.All,
		selectedTraits: [{ key: TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY, value: input.seedClass }],
		selectedTraitRanges: [],
		mediaMode: input.mediaMode ?? null,
		mediaPreference: input.mediaPreference ?? null
	});
	return normalizeTokenBrowserParams(raw, TOKEN_BROWSER_STATUS.All);
}

// Samples distinct token cards from a Seed Class pool.
export function sampleTerraformsSeedClassTokenCards(
	tokens: readonly ApiTokenCard[],
	count = TERRAFORMS_HYPERCASTLE_SEED_CLASS_SAMPLE_COUNT,
	random = Math.random
): ApiTokenCard[] {
	if (tokens.length <= count) return [...tokens];
	const indexes = tokens.map((_, index) => index);
	for (let index = indexes.length - 1; index > 0; index -= 1) {
		const swapIndex = Math.floor(random() * (index + 1));
		[indexes[index], indexes[swapIndex]] = [indexes[swapIndex]!, indexes[index]!];
	}
	return indexes.slice(0, count).map((index) => tokens[index]!);
}

function formatSeedRange(minInclusive: bigint, maxInclusive: bigint): string {
	return `${TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY} ${minInclusive.toString()}-${maxInclusive.toString()}`;
}

function formatSeedGreaterThan(lowerExclusive: bigint): string {
	return `${TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY} > ${lowerExclusive.toString()}`;
}

function formatSeedLessThanOrEqual(upperInclusive: bigint): string {
	return `${TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY} <= ${upperInclusive.toString()}`;
}

function formatTerraformsSeedClassHeading(seedClass: string): string {
	return `${TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.SeedClassHeadingPrefix}: ${seedClass}`;
}
