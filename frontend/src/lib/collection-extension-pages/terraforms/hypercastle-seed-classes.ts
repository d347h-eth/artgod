import { COLLECTION_MEDIA_MODES } from '@artgod/shared/extensions';
import {
	TERRAFORMS_MODE_ATTRIBUTE_VALUES,
	TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY,
	TERRAFORMS_RENDERER_SEED_THRESHOLDS,
	TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY,
	TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES
} from '@artgod/shared/extensions/terraforms';
import { TOKEN_BROWSER_STATUS } from '@artgod/shared/types/browse';
import type { ApiCollectionMediaState, ApiTokenCard } from '$lib/api-types';
import { buildTerraformsHypercastleTraitTokenHref } from '$lib/collection-extension-pages/terraforms/hypercastle-token-links';
import {
	buildTokenBrowserQuery,
	buildTokenDetailHref,
	normalizeTokenBrowserParams,
	TOKEN_BROWSER_DISPLAY_MODES
} from '$lib/token-browser-query';

type TerraformsHypercastleSeedClassRowKey = 'godmode' | 'x-seed' | 'y-seed';

export type TerraformsHypercastleSeedClassRow = {
	key: TerraformsHypercastleSeedClassRowKey;
	label: string;
	condition: string;
	summary: string;
	traitValue: string;
	rerollable: boolean;
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
		classLink: 'terraforms-hypercastle-seed-classes-class-link',
		rerollButton: 'terraforms-hypercastle-seed-classes-reroll-button',
		condition: 'terraforms-hypercastle-seed-classes-condition',
		sampleGrid: 'terraforms-hypercastle-seed-classes-sample-grid',
		status: 'terraforms-hypercastle-seed-classes-status'
	},
	testIds: {
		root: 'terraforms-hypercastle-seed-classes',
		seedClassList: 'terraforms-hypercastle-seed-class-list',
		seedClassBlock: 'terraforms-hypercastle-seed-class-block',
		sampleGrid: 'terraforms-hypercastle-seed-class-sample-grid',
		rerollButton: 'terraforms-hypercastle-seed-class-reroll'
	}
} as const;

// User-facing copy for the Terraforms Hypercastle seed-class section.
export const TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS = {
	Heading: 'Origins / Seed Classes',
	SeedTraitsHeading: 'Seed traits',
	SeedClassesHeading: 'Seed Class trait buckets',
	SeedTraitCopy:
		'The hidden renderer seed is stored as the Seed range trait. Seed Class is written only for the named cases below.',
	SampleLoading: 'loading examples',
	SampleEmpty: 'no examples found',
	SampleError: 'examples unavailable',
	Reroll: 'reroll examples'
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
export const TERRAFORMS_HYPERCASTLE_SEED_CLASS_ROWS: readonly TerraformsHypercastleSeedClassRow[] =
	[
		{
			key: 'x-seed',
			label: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed,
			condition: `${ORIGIN_MODE_LABEL}: ${formatSeedRange(
				ORIGIN_X_MIN_SEED,
				TERRAFORMS_RENDERER_SEED_THRESHOLDS.OverdriveLowerExclusive
			)}; ${NON_ORIGIN_MODE_LABEL}: ${formatSeedRange(NON_ORIGIN_X_MIN_SEED, MAX_SEED)}`,
			summary: 'X-Seeds can draw from every character range.',
			traitValue: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed,
			rerollable: true
		},
		{
			key: 'y-seed',
			label: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.YSeed,
			condition: `${NON_ORIGIN_MODE_LABEL}: ${formatSeedRange(OVERDRIVE_MIN_SEED, Y_SEED_MAX)}`,
			summary: 'Y-Seeds are non-Origin overdrive seeds where one early character range reverses.',
			traitValue: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.YSeed,
			rerollable: true
		},
		{
			key: 'godmode',
			label: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.Godmode,
			condition: `${ORIGIN_MODE_LABEL}; ${formatSeedGreaterThan(
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

// Chooses static snapshot media for embedded example cards when the collection supports it.
export function resolveTerraformsSeedClassCardMediaMode(media: ApiCollectionMediaState): string {
	return media.availableModes.some((mode) => mode.key === COLLECTION_MEDIA_MODES.Snapshot)
		? COLLECTION_MEDIA_MODES.Snapshot
		: media.selectedMode;
}

// Chooses artifact media for sample-card previews when the collection supports it.
export function resolveTerraformsSeedClassPreviewMediaMode(media: ApiCollectionMediaState): string {
	return media.availableModes.some((mode) => mode.key === COLLECTION_MEDIA_MODES.Artifact)
		? COLLECTION_MEDIA_MODES.Artifact
		: media.selectedMode;
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
