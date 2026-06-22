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
	TERRAFORMS_HYPERCASTLE_RENDERER_BUCKET_ROWS,
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
		const rendererRow = TERRAFORMS_HYPERCASTLE_RENDERER_BUCKET_ROWS.find(
			(row) => row.seedClass === TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.Godmode
		);

		expect(godmodeRow?.condition).toContain(originModes);
		expect(godmodeRow?.condition).toContain(
			`${TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY} > ${TERRAFORMS_RENDERER_SEED_THRESHOLDS.OverdriveLowerExclusive.toString()}`
		);
		expect(godmodeRow?.runtime).toContain('overdrive');
		expect(rendererRow?.runtime).toContain('passive height-0 playback uses the full charSet');
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
