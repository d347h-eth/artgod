import { describe, expect, it } from 'vitest';
import { COLLECTION_MEDIA_MODES } from '@artgod/shared/extensions';
import {
	TERRAFORMS_MODE_ATTRIBUTE_VALUES,
	TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY,
	TERRAFORMS_RENDERER_SEED_THRESHOLDS,
	TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES
} from '@artgod/shared/extensions/terraforms';
import {
	buildTerraformsHypercastleTokenHref,
	buildTerraformsSeedClassTokenHref,
	formatTerraformsHypercastleTokenLabel,
	TERRAFORMS_HYPERCASTLE_GODMODE_TOKENS,
	TERRAFORMS_HYPERCASTLE_SEED_CLASS_ROWS
} from '$lib/collection-extension-pages/terraforms/hypercastle-seed-classes';

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
		expect(godmodeRow?.effect).toContain('full passive character set');
	});

	it('keeps the table focused on named Seed Class traits', () => {
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
		expect(buildTerraformsHypercastleTokenHref('/ethereum/terraforms', '1955')).toBe(
			'/ethereum/terraforms/1955'
		);
		expect(formatTerraformsHypercastleTokenLabel('1955')).toBe('#1955');
	});
});
