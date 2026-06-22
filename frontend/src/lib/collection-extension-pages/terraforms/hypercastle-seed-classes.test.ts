import { describe, expect, it } from 'vitest';
import { COLLECTION_MEDIA_MODES, COLLECTION_MEDIA_QUERY_PARAMS } from '@artgod/shared/extensions';
import { PAGINATION_QUERY_PARAMS } from '@artgod/shared/config/pagination';
import { TOKEN_BROWSER_STATUS, TRAIT_FILTER_QUERY_PARAMS } from '@artgod/shared/types/browse';
import {
	TERRAFORMS_MODE_ATTRIBUTE_VALUES,
	TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY,
	TERRAFORMS_RENDERER_SEED_THRESHOLDS,
	TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY,
	TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES
} from '@artgod/shared/extensions/terraforms';
import type { ApiCollectionMediaState, ApiTokenCard } from '$lib/api-types';
import {
	buildTerraformsHypercastleTokenHref,
	buildTerraformsSeedClassSampleQuery,
	buildTerraformsSeedClassTokenHref,
	formatTerraformsHypercastleTokenLabel,
	resolveTerraformsSeedClassCardMediaMode,
	resolveTerraformsSeedClassPreviewMediaMode,
	sampleTerraformsSeedClassTokenCards,
	TERRAFORMS_HYPERCASTLE_GODMODE_TOKENS,
	TERRAFORMS_HYPERCASTLE_SEED_CLASS_SAMPLE_COUNT,
	TERRAFORMS_HYPERCASTLE_SEED_CLASS_SAMPLE_POOL_LIMIT,
	TERRAFORMS_HYPERCASTLE_SEED_CLASS_ROWS
} from '$lib/collection-extension-pages/terraforms/hypercastle-seed-classes';
import { TOKEN_STATUS_QUERY_PARAM } from '$lib/token-browser-query';

const TEST_MEDIA: ApiCollectionMediaState = {
	selectedMode: COLLECTION_MEDIA_MODES.Snapshot,
	defaultMode: COLLECTION_MEDIA_MODES.Snapshot,
	availableModes: [
		{ key: COLLECTION_MEDIA_MODES.Snapshot, label: COLLECTION_MEDIA_MODES.Snapshot },
		{ key: COLLECTION_MEDIA_MODES.Artifact, label: COLLECTION_MEDIA_MODES.Artifact }
	]
};

describe('Terraforms Hypercastle seed classes', () => {
	it('models Godmode as the origin overdrive bucket', () => {
		const originModes = [
			TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginDaydream,
			TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginTerraform
		].join(' / ');
		const godmodeRow = TERRAFORMS_HYPERCASTLE_SEED_CLASS_ROWS.find(
			(row) => row.traitValue === TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.Godmode
		);

		expect(godmodeRow?.condition).toContain(originModes);
		expect(godmodeRow?.condition).toContain(
			`${TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY} > ${TERRAFORMS_RENDERER_SEED_THRESHOLDS.OverdriveLowerExclusive.toString()}`
		);
		expect(godmodeRow?.summary).toContain('same full X-Seed ranges');
		expect(godmodeRow?.summary).toContain('passive height-0 cells');
	});

	it('keeps the section focused on named Seed Class traits', () => {
		expect(TERRAFORMS_HYPERCASTLE_SEED_CLASS_ROWS.map((row) => row.traitValue)).toEqual([
			TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed,
			TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.YSeed,
			TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.Godmode
		]);
	});

	it('keeps the canonical Godmode parcel list explicit', () => {
		expect(TERRAFORMS_HYPERCASTLE_GODMODE_TOKENS).toEqual([
			{ tokenId: '83', mode: TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginDaydream, seed: '9980' },
			{ tokenId: '1955', mode: TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginDaydream, seed: '9983' },
			{ tokenId: '124', mode: TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginDaydream, seed: '9996' }
		]);
	});

	it('builds links back into token browsing and token detail routes', () => {
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
		const query = buildTerraformsSeedClassSampleQuery({
			mediaMode: COLLECTION_MEDIA_MODES.Snapshot,
			seedClass: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed
		});

		expect(query.get(PAGINATION_QUERY_PARAMS.Limit)).toBe(
			String(TERRAFORMS_HYPERCASTLE_SEED_CLASS_SAMPLE_POOL_LIMIT)
		);
		expect(query.get(TOKEN_STATUS_QUERY_PARAM)).toBe(TOKEN_BROWSER_STATUS.All);
		expect(query.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaMode)).toBe(
			COLLECTION_MEDIA_MODES.Snapshot
		);
		expect(query.getAll(TRAIT_FILTER_QUERY_PARAMS.Traits)).toEqual([
			`${TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY}:${TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed}`
		]);
	});

	it('chooses static card media and animated preview media when available', () => {
		expect(resolveTerraformsSeedClassCardMediaMode(TEST_MEDIA)).toBe(
			COLLECTION_MEDIA_MODES.Snapshot
		);
		expect(resolveTerraformsSeedClassPreviewMediaMode(TEST_MEDIA)).toBe(
			COLLECTION_MEDIA_MODES.Artifact
		);
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
