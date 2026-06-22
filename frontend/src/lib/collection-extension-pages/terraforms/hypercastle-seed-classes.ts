import {
	TERRAFORMS_MODE_ATTRIBUTE_VALUES,
	buildTerraformsRendererExtraCharacterRanges,
	TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY,
	TERRAFORMS_RENDERER_SEED_THRESHOLDS,
	TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY,
	TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES
} from '@artgod/shared/extensions/terraforms';
import { TOKEN_BROWSER_STATUS } from '@artgod/shared/types/browse';
import type { ApiTokenCard } from '$lib/api-types';
import { buildTerraformsHypercastleTraitTokenHref } from '$lib/collection-extension-pages/terraforms/hypercastle-token-links';
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

export type TerraformsHypercastleSeedClassRow = {
	key: TerraformsHypercastleSeedClassRowKey;
	label: string;
	condition: string;
	summary: string;
	traitValue: string;
	rerollable: boolean;
	characterSets?: readonly TerraformsHypercastleExtraCharacterSet[];
};

export type TerraformsHypercastleOriginSection = {
	heading: string;
	condition: string;
	summary: string;
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
		blockHeader: 'terraforms-hypercastle-seed-classes-block-header',
		blockTitle: 'terraforms-hypercastle-seed-classes-block-title',
		classLink: 'terraforms-hypercastle-seed-classes-class-link',
		rerollButton: 'terraforms-hypercastle-seed-classes-reroll-button',
		condition: 'terraforms-hypercastle-seed-classes-condition',
		characterSets: 'terraforms-hypercastle-seed-classes-character-sets',
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
	SeedTraitsHeading: 'Seed traits',
	OriginsHeading: 'Origins',
	SeedClassesHeading: 'Seed Class trait buckets',
	OriginScope: 'Origin',
	NonOriginScope: 'Non-Origin',
	SeedTraitCopy:
		'Each parcel has a hidden seed that shapes its rendered character set. A few narrow seed ranges create the special Seed Classes below.',
	OriginsCondition: 'Mode: Origin',
	OriginsCopy:
		'Origin parcels were created through the mintpass redemption path and keep their Origin lineage after terraforming. They do not have separate character ranges: lower seeds build from one of the same non-biome ranges shown below, while higher Origin seeds use all of them.',
	SampleLoading: 'loading examples',
	SampleEmpty: 'no examples found',
	SampleError: 'examples unavailable',
	Reroll: 'reroll examples'
} as const;

const OVERDRIVE_MIN_SEED = TERRAFORMS_RENDERER_SEED_THRESHOLDS.OverdriveLowerExclusive + 1n;
const ORIGIN_X_MIN_SEED = TERRAFORMS_RENDERER_SEED_THRESHOLDS.OriginXSeed + 1n;
const NON_ORIGIN_X_MIN_SEED = TERRAFORMS_RENDERER_SEED_THRESHOLDS.NonOriginXSeed + 1n;
const Y_SEED_MAX = TERRAFORMS_RENDERER_SEED_THRESHOLDS.YSeedUpperInclusive;
const MAX_SEED = TERRAFORMS_RENDERER_SEED_THRESHOLDS.Modulus - 1n;
const EXTRA_CHARACTER_SET_KEY_PREFIX = 'extra-character-set';

// Extra character rows mirror the V2 renderer order used by X-Seeds and Godmode.
export const TERRAFORMS_HYPERCASTLE_EXTRA_CHARACTER_SETS: readonly TerraformsHypercastleExtraCharacterSet[] =
	buildTerraformsRendererExtraCharacterRanges().map((characters, index) => ({
		key: [EXTRA_CHARACTER_SET_KEY_PREFIX, String(index)].join('-'),
		characters,
		characterLabels: characters
	}));

// Origin is a mode lineage with renderer branches, not a Seed Class trait value.
export const TERRAFORMS_HYPERCASTLE_ORIGIN_SECTION: TerraformsHypercastleOriginSection = {
	heading: TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.OriginsHeading,
	condition: `${TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.OriginsCondition}
${formatSeedLessThanOrEqual(TERRAFORMS_RENDERER_SEED_THRESHOLDS.OriginXSeed)}: one range
${formatSeedGreaterThan(TERRAFORMS_RENDERER_SEED_THRESHOLDS.OriginXSeed)}: all ranges`,
	summary: TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.OriginsCopy
};

// Seed Class rows map first-class trait values to their compact renderer conditions.
export const TERRAFORMS_HYPERCASTLE_SEED_CLASS_ROWS: readonly TerraformsHypercastleSeedClassRow[] =
	[
		{
			key: 'x-seed',
			label: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed,
			condition: `${TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.OriginScope}: ${formatSeedRange(
				ORIGIN_X_MIN_SEED,
				TERRAFORMS_RENDERER_SEED_THRESHOLDS.OverdriveLowerExclusive
			)}
${TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.NonOriginScope}: ${formatSeedRange(NON_ORIGIN_X_MIN_SEED, MAX_SEED)}`,
			summary: 'X-Seeds can draw from every non-biome character range shown here.',
			traitValue: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed,
			rerollable: true,
			characterSets: TERRAFORMS_HYPERCASTLE_EXTRA_CHARACTER_SETS
		},
		{
			key: 'y-seed',
			label: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.YSeed,
			condition: `${TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.NonOriginScope}: ${formatSeedRange(OVERDRIVE_MIN_SEED, Y_SEED_MAX)}`,
			summary:
				'Y-Seeds are non-Origin tokens in the listed Seed range. Their renderer draws from a narrow 10-character set.',
			traitValue: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.YSeed,
			rerollable: true
		},
		{
			key: 'godmode',
			label: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.Godmode,
			condition: `${TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.OriginScope}: ${formatSeedGreaterThan(
				TERRAFORMS_RENDERER_SEED_THRESHOLDS.OverdriveLowerExclusive
			)}`,
			summary:
				'Godmode is an Origin X-Seed in overdrive. It has the same full X-Seed ranges; the difference is that passive height-0 cells also use the full character set.',
			traitValue: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.Godmode,
			rerollable: false
		}
	] as const;

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

// Builds a token-detail href for a Terraforms sample token card.
export function buildTerraformsHypercastleTokenHref(input: {
	basePath: string;
	tokenId: string;
	mediaMode?: string | null;
}): string {
	return buildTokenDetailHref({
		basePath: input.basePath,
		tokenId: input.tokenId,
		mediaMode: input.mediaMode ?? null
	});
}

// Formats Terraforms token labels for sample card metadata and tests.
export function formatTerraformsHypercastleTokenLabel(tokenId: string): string {
	return `#${tokenId}`;
}

// Builds the collection-detail query used to load Seed Class sample cards.
export function buildTerraformsSeedClassSampleQuery(input: {
	mediaMode?: string | null;
	seedClass: string;
}): URLSearchParams {
	const raw = buildTokenBrowserQuery({
		limit: TERRAFORMS_HYPERCASTLE_SEED_CLASS_SAMPLE_POOL_LIMIT,
		displayMode: TOKEN_BROWSER_DISPLAY_MODES.Grid,
		tokenStatus: TOKEN_BROWSER_STATUS.All,
		selectedTraits: [{ key: TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY, value: input.seedClass }],
		selectedTraitRanges: [],
		mediaMode: input.mediaMode ?? null
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
