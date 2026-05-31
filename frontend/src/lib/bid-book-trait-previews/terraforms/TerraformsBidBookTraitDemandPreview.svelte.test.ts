import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import {
	TERRAFORMS_BIOME_ATTRIBUTE_KEY,
	TERRAFORMS_ZONE_ATTRIBUTE_KEY
} from '@artgod/shared/extensions/terraforms';
import {
	TERRAFORMS_BIOME_CHARACTER_BAND_DOM,
	TERRAFORMS_ZONE_PALETTE_BAND_DOM
} from '$lib/collection-extension-pages/terraforms/trait-previews';
import TerraformsBidBookTraitDemandPreview from '$lib/bid-book-trait-previews/terraforms/TerraformsBidBookTraitDemandPreview.svelte';
import {
	resolveTerraformsBidBookTraitPreview,
	TERRAFORMS_BID_BOOK_TRAIT_PREVIEW_DOM,
	TERRAFORMS_BID_BOOK_TRAIT_PREVIEW_KINDS
} from '$lib/bid-book-trait-previews/terraforms/preview-model';

function countTestId(body: string, testId: string): number {
	return body.match(new RegExp(`data-testid="${testId}"`, 'g'))?.length ?? 0;
}

describe('TerraformsBidBookTraitDemandPreview', () => {
	it('resolves Zone-only trait buckets to palette previews', () => {
		const preview = resolveTerraformsBidBookTraitPreview([
			{ type: TERRAFORMS_ZONE_ATTRIBUTE_KEY, value: 'Shahra' }
		]);

		expect(preview?.kind).toBe(TERRAFORMS_BID_BOOK_TRAIT_PREVIEW_KINDS.Zone);
		const { body } = render(TerraformsBidBookTraitDemandPreview, {
			props: {
				traits: [{ type: TERRAFORMS_ZONE_ATTRIBUTE_KEY, value: 'Shahra' }]
			}
		});

		expect(body).toContain(TERRAFORMS_BID_BOOK_TRAIT_PREVIEW_DOM.testIds.root);
		expect(countTestId(body, TERRAFORMS_ZONE_PALETTE_BAND_DOM.testIds.swatch)).toBe(10);
		expect(body).not.toContain(TERRAFORMS_BIOME_CHARACTER_BAND_DOM.testIds.character);
	});

	it('resolves Biome-only trait buckets to uncolored character previews', () => {
		const preview = resolveTerraformsBidBookTraitPreview([
			{ type: TERRAFORMS_BIOME_ATTRIBUTE_KEY, value: '42' }
		]);

		expect(preview?.kind).toBe(TERRAFORMS_BID_BOOK_TRAIT_PREVIEW_KINDS.Biome);
		const { body } = render(TerraformsBidBookTraitDemandPreview, {
			props: {
				traits: [{ type: TERRAFORMS_BIOME_ATTRIBUTE_KEY, value: '42' }]
			}
		});

		expect(body).toContain(TERRAFORMS_BID_BOOK_TRAIT_PREVIEW_DOM.testIds.root);
		expect(countTestId(body, TERRAFORMS_BIOME_CHARACTER_BAND_DOM.testIds.character)).toBe(9);
		expect(body).not.toContain(TERRAFORMS_ZONE_PALETTE_BAND_DOM.testIds.swatch);
	});

	it('resolves paired Zone and Biome buckets to colored character previews', () => {
		const preview = resolveTerraformsBidBookTraitPreview([
			{ type: TERRAFORMS_ZONE_ATTRIBUTE_KEY, value: 'Shahra' },
			{ type: TERRAFORMS_BIOME_ATTRIBUTE_KEY, value: '42' }
		]);

		expect(preview?.kind).toBe(TERRAFORMS_BID_BOOK_TRAIT_PREVIEW_KINDS.ZoneBiome);
		const { body } = render(TerraformsBidBookTraitDemandPreview, {
			props: {
				traits: [
					{ type: TERRAFORMS_ZONE_ATTRIBUTE_KEY, value: 'Shahra' },
					{ type: TERRAFORMS_BIOME_ATTRIBUTE_KEY, value: '42' }
				]
			}
		});

		expect(body).toContain(TERRAFORMS_BID_BOOK_TRAIT_PREVIEW_DOM.testIds.root);
		expect(countTestId(body, TERRAFORMS_BIOME_CHARACTER_BAND_DOM.testIds.character)).toBe(9);
		expect(body).not.toContain(TERRAFORMS_ZONE_PALETTE_BAND_DOM.testIds.swatch);
	});
});
