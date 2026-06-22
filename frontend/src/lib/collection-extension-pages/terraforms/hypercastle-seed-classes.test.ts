import { describe, expect, it } from 'vitest';
import { COLLECTION_MEDIA_MODES, COLLECTION_MEDIA_QUERY_PARAMS } from '@artgod/shared/extensions';
import { PAGINATION_QUERY_PARAMS } from '@artgod/shared/config/pagination';
import { TOKEN_BROWSER_STATUS, TRAIT_FILTER_QUERY_PARAMS } from '@artgod/shared/types/browse';
import {
	TERRAFORMS_MODE_ATTRIBUTE_KEY,
	TERRAFORMS_MODE_ATTRIBUTE_VALUES,
	TERRAFORMS_RENDERER_EXTRA_CHARACTER_RANGE_STARTS,
	TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY,
	TERRAFORMS_RENDERER_SEED_THRESHOLDS,
	TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY,
	TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES
} from '@artgod/shared/extensions/terraforms';
import type { ApiTokenCard } from '$lib/api-types';
import {
	buildTerraformsHypercastleTokenHref,
	buildTerraformsOriginSampleQuery,
	buildTerraformsOriginTokenHref,
	buildTerraformsSeedClassSampleQuery,
	buildTerraformsSeedClassTokenHref,
	formatTerraformsHypercastleTokenLabel,
	sampleTerraformsSeedClassTokenCards,
	TERRAFORMS_HYPERCASTLE_GODMODE_TOKENS,
	TERRAFORMS_HYPERCASTLE_ORIGIN_SECTION,
	TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS,
	TERRAFORMS_HYPERCASTLE_SEED_CLASS_SAMPLE_COUNT,
	TERRAFORMS_HYPERCASTLE_SEED_CLASS_SAMPLE_POOL_LIMIT,
	TERRAFORMS_HYPERCASTLE_SEED_CLASS_ROWS,
	TERRAFORMS_HYPERCASTLE_Y_SEED_CHARACTER_SET_COUNT,
	TERRAFORMS_HYPERCASTLE_Y_SEED_CHARACTER_SETS
} from '$lib/collection-extension-pages/terraforms/hypercastle-seed-classes';
import { TOKEN_STATUS_QUERY_PARAM } from '$lib/token-browser-query';

describe('Terraforms Hypercastle seed classes', () => {
	it('models Godmode as the origin overdrive bucket', () => {
		const godmodeRow = TERRAFORMS_HYPERCASTLE_SEED_CLASS_ROWS.find(
			(row) => row.traitValue === TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.Godmode
		);

		expect(godmodeRow?.condition).toContain(
			`${TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.OriginScope}:`
		);
		expect(godmodeRow?.condition).toContain(
			`${TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY} > ${TERRAFORMS_RENDERER_SEED_THRESHOLDS.OverdriveLowerExclusive.toString()}`
		);
		expect(godmodeRow?.summary.linkLabel).toBe(TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.Godmode);
		expect(godmodeRow?.heading).toBe(
			`${TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.SeedClassHeadingPrefix}: ${TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.Godmode}`
		);
		expect(godmodeRow?.summary.rest).toContain('same full non-biome charset set as X-Seeds');
		expect(godmodeRow?.summary.rest).toContain('passive height-0 cells');
		expect(godmodeRow?.summary.rest).toContain(
			`Only ${TERRAFORMS_HYPERCASTLE_GODMODE_TOKENS.length} parcels are Godmode, shown below`
		);
	});

	it('keeps the section focused on named Seed Class traits', () => {
		expect(TERRAFORMS_HYPERCASTLE_SEED_CLASS_ROWS.map((row) => row.traitValue)).toEqual([
			TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed,
			TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.YSeed,
			TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.Godmode
		]);
	});

	it('keeps Origin as mode lineage separate from Seed Class traits', () => {
		expect(TERRAFORMS_HYPERCASTLE_ORIGIN_SECTION.condition).toContain(
			TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.OriginsCondition
		);
		expect(TERRAFORMS_HYPERCASTLE_ORIGIN_SECTION.condition).toContain(
			`${TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY} <= ${TERRAFORMS_RENDERER_SEED_THRESHOLDS.OriginXSeed.toString()}`
		);
		expect(TERRAFORMS_HYPERCASTLE_ORIGIN_SECTION.condition).toContain(
			`${TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY} > ${TERRAFORMS_RENDERER_SEED_THRESHOLDS.OriginXSeed.toString()}`
		);
		expect(TERRAFORMS_HYPERCASTLE_ORIGIN_SECTION.summary.linkLabel).toBe(
			TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.OriginsCopyLink
		);
		expect(TERRAFORMS_HYPERCASTLE_ORIGIN_SECTION.summary.rest).toContain(
			'mintpass redemption path'
		);
		expect(TERRAFORMS_HYPERCASTLE_ORIGIN_SECTION.summary.rest).not.toContain(
			'separate charsets'
		);
		expect(TERRAFORMS_HYPERCASTLE_ORIGIN_SECTION.summary.rest).toContain(
			`${TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY} 0-${TERRAFORMS_RENDERER_SEED_THRESHOLDS.OriginXSeed.toString()}`
		);
		expect(TERRAFORMS_HYPERCASTLE_ORIGIN_SECTION.summary.rest).toContain('non-biome set');
		expect(TERRAFORMS_HYPERCASTLE_ORIGIN_SECTION.summary.rest).toContain(
			`${TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY} ${(
				TERRAFORMS_RENDERER_SEED_THRESHOLDS.OriginXSeed + 1n
			).toString()}-${(TERRAFORMS_RENDERER_SEED_THRESHOLDS.Modulus - 1n).toString()}`
		);
		expect(TERRAFORMS_HYPERCASTLE_ORIGIN_SECTION.summary.rest).not.toContain('lower');
		expect(TERRAFORMS_HYPERCASTLE_ORIGIN_SECTION.summary.rest).not.toContain('higher');
	});

	it('shows all renderer extra charsets in the Origin section', () => {
		const xSeedRow = TERRAFORMS_HYPERCASTLE_SEED_CLASS_ROWS.find(
			(row) => row.traitValue === TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed
		);

		expect(TERRAFORMS_HYPERCASTLE_ORIGIN_SECTION.characterSets).toHaveLength(
			TERRAFORMS_RENDERER_EXTRA_CHARACTER_RANGE_STARTS.length
		);
		expect(xSeedRow?.heading).toBe(
			`${TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.SeedClassHeadingPrefix}: ${TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed}`
		);
		expect(xSeedRow?.summary.linkLabel).toBe(TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed);
		expect(xSeedRow?.summary.rest).toContain('shown in Origins');
		expect(TERRAFORMS_HYPERCASTLE_ORIGIN_SECTION.characterSets[0]?.characters.join('')).toBe(
			'▀▁▂▃▄▅▆▇█▉'
		);
		expect(TERRAFORMS_HYPERCASTLE_ORIGIN_SECTION.characterSets[7]?.characters[0]).toBe('⿱');
	});

	it('uses compact Origin and Non-Origin condition labels', () => {
		const xSeedRow = TERRAFORMS_HYPERCASTLE_SEED_CLASS_ROWS.find(
			(row) => row.traitValue === TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed
		);
		const ySeedRow = TERRAFORMS_HYPERCASTLE_SEED_CLASS_ROWS.find(
			(row) => row.traitValue === TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.YSeed
		);

		expect(xSeedRow?.condition).toContain(
			`${TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.OriginScope}:`
		);
		expect(xSeedRow?.condition).toContain(
			`\n${TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.NonOriginScope}:`
		);
		expect(xSeedRow?.condition).not.toContain(';');
		expect(ySeedRow?.condition).toContain(
			`${TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.NonOriginScope}:`
		);
		expect(ySeedRow?.summary.rest).not.toContain('overdrive');
		expect(ySeedRow?.summary.rest).toContain('reversed character order');
	});

	it('defines the Y-Seed charsets precisely', () => {
		const ySeedRow = TERRAFORMS_HYPERCASTLE_SEED_CLASS_ROWS.find(
			(row) => row.traitValue === TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.YSeed
		);

		expect(ySeedRow?.summary.linkLabel).toBe(TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.YSeed);
		expect(ySeedRow?.heading).toBe(
			`${TERRAFORMS_HYPERCASTLE_SEED_CLASS_LABELS.SeedClassHeadingPrefix}: ${TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.YSeed}`
		);
		expect(ySeedRow?.summary.rest).toContain(
			`reversed character order of one of the first ${TERRAFORMS_HYPERCASTLE_Y_SEED_CHARACTER_SET_COUNT} 10-character Origin charsets`
		);
		expect(ySeedRow?.summary.rest).not.toContain('narrow');
		expect(ySeedRow?.characterSets).toEqual(TERRAFORMS_HYPERCASTLE_Y_SEED_CHARACTER_SETS);
		expect(TERRAFORMS_HYPERCASTLE_Y_SEED_CHARACTER_SET_COUNT).toBe(3);
		expect(TERRAFORMS_HYPERCASTLE_Y_SEED_CHARACTER_SETS).toHaveLength(
			TERRAFORMS_HYPERCASTLE_Y_SEED_CHARACTER_SET_COUNT
		);
		for (const [index, characterSet] of TERRAFORMS_HYPERCASTLE_Y_SEED_CHARACTER_SETS.entries()) {
			const originCharacters = TERRAFORMS_HYPERCASTLE_ORIGIN_SECTION.characterSets[index]?.characters;
			expect(characterSet.characters).toEqual([...(originCharacters ?? [])].reverse());
		}
		expect(TERRAFORMS_HYPERCASTLE_Y_SEED_CHARACTER_SETS[0]?.characters.join('')).toBe(
			'▉█▇▆▅▄▃▂▁▀'
		);
	});

	it('keeps the canonical Godmode parcel list explicit', () => {
		expect(TERRAFORMS_HYPERCASTLE_GODMODE_TOKENS).toEqual([
			{ tokenId: '83', mode: TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginDaydream, seed: '9980' },
			{ tokenId: '1955', mode: TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginDaydream, seed: '9983' },
			{ tokenId: '124', mode: TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginDaydream, seed: '9996' }
		]);
	});

	it('builds links back into token browsing and token detail routes', () => {
		const originHref = buildTerraformsOriginTokenHref({
			basePath: '/ethereum/terraforms',
			mediaMode: COLLECTION_MEDIA_MODES.Artifact
		});
		const originQuery = new URL(originHref, 'http://artgod.local').searchParams;

		expect(originQuery.getAll(TRAIT_FILTER_QUERY_PARAMS.Traits)).toEqual([
			`${TERRAFORMS_MODE_ATTRIBUTE_KEY}:${TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginDaydream}`,
			`${TERRAFORMS_MODE_ATTRIBUTE_KEY}:${TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginTerraform}`
		]);
		expect(originQuery.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaMode)).toBe(
			COLLECTION_MEDIA_MODES.Artifact
		);
		expect(
			buildTerraformsSeedClassTokenHref({
				basePath: '/ethereum/terraforms',
				mediaMode: COLLECTION_MEDIA_MODES.Artifact,
				seedClass: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.Godmode
			})
		).toContain('traits=Seed+Class%3AGodmode');
		expect(
			buildTerraformsHypercastleTokenHref({
				basePath: '/ethereum/terraforms',
				tokenId: '1955',
				mediaMode: COLLECTION_MEDIA_MODES.Artifact
			})
		).toBe('/ethereum/terraforms/1955?media_mode=artifact');
		expect(formatTerraformsHypercastleTokenLabel('1955')).toBe('#1955');
	});

	it('builds a normalized API query for loading sample token cards', () => {
		const originQuery = buildTerraformsOriginSampleQuery({
			mediaMode: COLLECTION_MEDIA_MODES.Artifact
		});
		const seedClassQuery = buildTerraformsSeedClassSampleQuery({
			mediaMode: COLLECTION_MEDIA_MODES.Artifact,
			seedClass: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed
		});

		expect(originQuery.get(PAGINATION_QUERY_PARAMS.Limit)).toBe(
			String(TERRAFORMS_HYPERCASTLE_SEED_CLASS_SAMPLE_POOL_LIMIT)
		);
		expect(originQuery.get(TOKEN_STATUS_QUERY_PARAM)).toBe(TOKEN_BROWSER_STATUS.All);
		expect(originQuery.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaMode)).toBe(
			COLLECTION_MEDIA_MODES.Artifact
		);
		expect(originQuery.getAll(TRAIT_FILTER_QUERY_PARAMS.Traits)).toEqual([
			`${TERRAFORMS_MODE_ATTRIBUTE_KEY}:${TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginDaydream}`,
			`${TERRAFORMS_MODE_ATTRIBUTE_KEY}:${TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginTerraform}`
		]);
		expect(seedClassQuery.get(PAGINATION_QUERY_PARAMS.Limit)).toBe(
			String(TERRAFORMS_HYPERCASTLE_SEED_CLASS_SAMPLE_POOL_LIMIT)
		);
		expect(seedClassQuery.get(TOKEN_STATUS_QUERY_PARAM)).toBe(TOKEN_BROWSER_STATUS.All);
		expect(seedClassQuery.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaMode)).toBe(
			COLLECTION_MEDIA_MODES.Artifact
		);
		expect(seedClassQuery.getAll(TRAIT_FILTER_QUERY_PARAMS.Traits)).toEqual([
			`${TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY}:${TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed}`
		]);
	});

	it('samples distinct token cards with an injectable random source', () => {
		const tokens = Array.from({ length: 5 }, (_, index) => tokenCardFixture(String(index + 1)));
		const sample = sampleTerraformsSeedClassTokenCards(
			tokens,
			TERRAFORMS_HYPERCASTLE_SEED_CLASS_SAMPLE_COUNT,
			() => 0
		);

		expect(sample).toHaveLength(TERRAFORMS_HYPERCASTLE_SEED_CLASS_SAMPLE_COUNT);
		expect(new Set(sample.map((token) => token.tokenId)).size).toBe(sample.length);
	});
});

function tokenCardFixture(tokenId: string): ApiTokenCard {
	return {
		tokenId,
		name: `Token ${tokenId}`,
		image: null,
		traitSummary: null,
		listingPrice: null,
		listingCurrency: null,
		attributes: [],
		hasMetadata: true,
		metadataUpdatedAt: null
	};
}
