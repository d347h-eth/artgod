import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import { TERRAFORMS_BIOMES } from '@artgod/shared/extensions/terraforms';
import {
	applyTerraformsBiomeTokenCounts,
	buildTerraformsBiomeRows,
	buildTerraformsBiomeTokenHref,
	formatTerraformsBiomeMintedTokenCount,
	resolveTerraformsBiomeAriaSort,
	resolveTerraformsBiomeDefaultSortDirection,
	resolveTerraformsBiomeDisplayCharacters,
	resolveTerraformsBiomePreviewBackgroundColor,
	resolveTerraformsBiomePreviewCharacterColor,
	sortTerraformsBiomeRows,
	TERRAFORMS_BIOME_TABLE_COLUMNS
} from '$lib/collection-extension-pages/terraforms/biomes';
import {
	TERRAFORMS_TRAIT_TABLE_ARIA_SORT_VALUES,
	TERRAFORMS_TRAIT_TABLE_SORT_DIRECTIONS
} from '$lib/collection-extension-pages/terraforms/trait-table';

const TERRAFORMS_MOUNTAIN_BIOME_INDEX = 22;
const TERRAFORMS_RAIN_CLOUD_BIOME_INDEX = 23;
const TERRAFORMS_MOUNTAIN_BIOME_DISPLAY_CHARACTERS = [
	'▒',
	'🏔',
	'▒',
	'☎',
	'☎',
	'▒',
	'🏔',
	'☆',
	'░'
] as const;
const TERRAFORMS_RAIN_CLOUD_BIOME_DISPLAY_CHARACTERS = [
	'🌧',
	'🌧',
	'░',
	'⾂',
	'▒',
	'░',
	'🏔',
	'🏔',
	'🏔'
] as const;

describe('Terraforms Biome table data', () => {
	it('builds the all-level Biome catalog from static contract data', () => {
		const rows = buildTerraformsBiomeRows();

		expect(rows).toHaveLength(TERRAFORMS_BIOMES.length);
		expect(rows[0]).toMatchObject({
			biomeIndex: 0,
			characters: TERRAFORMS_BIOMES[0]!.characters
		});
		expect(rows[0]!.characters).toHaveLength(9);
		expect(rows[0]!.displayCharacters).toBe(rows[0]!.characters);
	});

	it('maps placeholder contract characters to Mathcastles Remix display glyphs', () => {
		const rows = buildTerraformsBiomeRows();
		const mountainBiome = TERRAFORMS_BIOMES[TERRAFORMS_MOUNTAIN_BIOME_INDEX]!;
		const rainCloudBiome = TERRAFORMS_BIOMES[TERRAFORMS_RAIN_CLOUD_BIOME_INDEX]!;
		const mountainRow = rows[TERRAFORMS_MOUNTAIN_BIOME_INDEX]!;
		const rainCloudRow = rows[TERRAFORMS_RAIN_CLOUD_BIOME_INDEX]!;

		expect(mountainBiome.characters).toContain('?');
		expect(rainCloudBiome.characters).toContain('?');
		expect(mountainRow.characters).toEqual(mountainBiome.characters);
		expect(rainCloudRow.characters).toEqual(rainCloudBiome.characters);
		expect(mountainRow.displayCharacters).toEqual(TERRAFORMS_MOUNTAIN_BIOME_DISPLAY_CHARACTERS);
		expect(rainCloudRow.displayCharacters).toEqual(TERRAFORMS_RAIN_CLOUD_BIOME_DISPLAY_CHARACTERS);
		expect(resolveTerraformsBiomeDisplayCharacters(mountainBiome)).toEqual(
			TERRAFORMS_MOUNTAIN_BIOME_DISPLAY_CHARACTERS
		);
	});

	it('applies minted token counts to Biome rows for display', () => {
		const rows = applyTerraformsBiomeTokenCounts(
			buildTerraformsBiomeRows().slice(22, 24),
			{
				22: 8,
				23: 13
			},
			true
		);

		expect(rows.map((row) => formatTerraformsBiomeMintedTokenCount(row))).toEqual(['8', '13']);
	});

	it('sorts and filters Biome rows with the shared trait table contract', () => {
		const rows = applyTerraformsBiomeTokenCounts(
			buildTerraformsBiomeRows().slice(22, 25),
			{
				22: 0,
				23: 13,
				24: 8
			},
			true,
			{ mintedOnly: true }
		);

		expect(rows.map((row) => row.biomeIndex)).toEqual([23, 24]);
		expect(
			sortTerraformsBiomeRows(
				rows,
				TERRAFORMS_BIOME_TABLE_COLUMNS.Minted,
				TERRAFORMS_TRAIT_TABLE_SORT_DIRECTIONS.Descending
			).map((row) => row.biomeIndex)
		).toEqual([23, 24]);
		expect(
			sortTerraformsBiomeRows(
				rows,
				TERRAFORMS_BIOME_TABLE_COLUMNS.Number,
				TERRAFORMS_TRAIT_TABLE_SORT_DIRECTIONS.Descending
			).map((row) => row.biomeIndex)
		).toEqual([24, 23]);
		expect(resolveTerraformsBiomeDefaultSortDirection(TERRAFORMS_BIOME_TABLE_COLUMNS.Number)).toBe(
			TERRAFORMS_TRAIT_TABLE_SORT_DIRECTIONS.Ascending
		);
		expect(
			resolveTerraformsBiomeAriaSort(
				TERRAFORMS_BIOME_TABLE_COLUMNS.Minted,
				TERRAFORMS_BIOME_TABLE_COLUMNS.Minted,
				TERRAFORMS_TRAIT_TABLE_SORT_DIRECTIONS.Descending
			)
		).toBe(TERRAFORMS_TRAIT_TABLE_ARIA_SORT_VALUES.Descending);
	});

	it('maps Zone palettes to Biome character preview colors', () => {
		const palette = [
			'#000001',
			'#000002',
			'#000003',
			'#000004',
			'#000005',
			'#000006',
			'#000007',
			'#000008',
			'#000009',
			'#000010'
		];

		expect(resolveTerraformsBiomePreviewCharacterColor(palette, 0)).toBe('#000001');
		expect(resolveTerraformsBiomePreviewCharacterColor(palette, 8)).toBe('#000009');
		expect(resolveTerraformsBiomePreviewBackgroundColor(palette)).toBe('#000010');
		expect(resolveTerraformsBiomePreviewCharacterColor(null, 0)).toBeNull();
		expect(resolveTerraformsBiomePreviewBackgroundColor(null)).toBeNull();
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
