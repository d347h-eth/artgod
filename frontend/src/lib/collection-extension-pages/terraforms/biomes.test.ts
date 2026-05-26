import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import { TERRAFORMS_BIOMES } from '@artgod/shared/extensions/terraforms';
import {
	buildTerraformsBiomeRows,
	buildTerraformsBiomeTokenHref
} from '$lib/collection-extension-pages/terraforms/biomes';

describe('Terraforms Biome table data', () => {
	it('builds the all-level Biome catalog from static contract data', () => {
		const rows = buildTerraformsBiomeRows();

		expect(rows).toHaveLength(TERRAFORMS_BIOMES.length);
		expect(rows[0]).toMatchObject({
			biomeIndex: 0,
			characters: TERRAFORMS_BIOMES[0]!.characters
		});
		expect(rows[0]!.characters).toHaveLength(9);
	});

	it('builds Biome token-filter hrefs for the pure token browser', () => {
		expect(
			buildTerraformsBiomeTokenHref({
				basePath: '/ethereum/terraforms',
				biomeIndex: 42
			})
		).toBe(
			`/ethereum/terraforms?limit=${DEFAULT_PAGE_LIMIT}&mode=grid&token_status=all&traits=Biome%3A42`
		);
	});
});
